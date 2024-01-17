import { ExpressionToken, LiqeQuery } from '@omnivore/liqe'
import { DateTime } from 'luxon'
import { DeepPartial, FindOptionsWhere, ObjectLiteral } from 'typeorm'
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity'
import { EntityLabel } from '../entity/entity_label'
import { Highlight } from '../entity/highlight'
import { Label } from '../entity/label'
import { LibraryItem, LibraryItemState } from '../entity/library_item'
import { env } from '../env'
import { BulkActionType, InputMaybe, SortParams } from '../generated/graphql'
import { createPubSubClient, EntityType } from '../pubsub'
import {
  authTrx,
  getColumns,
  queryBuilderToRawSql,
  valuesToRawSql,
} from '../repository'
import { libraryItemRepository } from '../repository/library_item'
import { setRecentlySavedItemInRedis, wordsCount } from '../utils/helpers'
import { logger } from '../utils/logger'
import { parseSearchQuery } from '../utils/search'

enum ReadFilter {
  ALL = 'all',
  READ = 'read',
  READING = 'reading',
  UNREAD = 'unread',
}

enum InFilter {
  ALL = 'all',
  INBOX = 'inbox',
  ARCHIVE = 'archive',
  TRASH = 'trash',
  FOLLOWING = 'following',
}

export interface SearchArgs {
  from?: number
  size?: number
  includePending?: boolean | null
  includeDeleted?: boolean
  includeContent?: boolean
  useFolders?: boolean
  query?: string | null
}

export interface SearchResultItem {
  annotation?: string | null
  author?: string | null
  createdAt: Date
  description?: string | null
  id: string
  image?: string | null
  pageId?: string
  pageType: string
  publishedAt?: Date
  quote?: string | null
  shortId?: string | null
  slug: string
  title: string
  uploadFileId?: string | null
  url: string
  readingProgressTopPercent?: number
  readingProgressPercent: number
  readingProgressAnchorIndex: number
  userId: string
  state?: LibraryItemState
  language?: string
  readAt?: Date
  savedAt: Date
  updatedAt?: Date
  labels?: Label[]
  highlights?: Highlight[]
  wordsCount?: number
  siteName?: string
  siteIcon?: string
  content?: string
}

export enum SortBy {
  SAVED = 'saved',
  UPDATED = 'updated',
  PUBLISHED = 'published',
  READ = 'read',
  WORDS_COUNT = 'wordscount',
}

export enum SortOrder {
  ASCENDING = 'ASC',
  DESCENDING = 'DESC',
}

export interface Sort {
  by: string
  order?: SortOrder
  nulls?: 'NULLS FIRST' | 'NULLS LAST'
}

interface Select {
  column: string
  alias?: string
}

const handleNoCase = (value: string) => {
  const keywordRegexMap: Record<string, RegExp> = {
    highlight: /^highlight(s)?$/i,
    label: /^label(s)?$/i,
    subscription: /^subscription(s)?$/i,
  }

  const matchingKeyword = Object.keys(keywordRegexMap).find((keyword) =>
    value.match(keywordRegexMap[keyword])
  )

  if (matchingKeyword) {
    const column = getColumnName(matchingKeyword)
    return `(library_item.${column} IS NULL OR library_item.${column} = '{}')`
  }

  throw new Error(`Unexpected keyword: ${value}`)
}

const paramtersToObject = (parameters: ObjectLiteral[]) => {
  return parameters.reduce((a, b) => ({ ...a, ...b }), {})
}

export const sortParamsToSort = (
  sortParams: InputMaybe<SortParams> | undefined
) => {
  const sort = { by: SortBy.UPDATED, order: SortOrder.DESCENDING }

  if (sortParams) {
    sortParams.order === 'ASCENDING' && (sort.order = SortOrder.ASCENDING)
    switch (sortParams.by) {
      case 'UPDATED_TIME':
        sort.by = SortBy.UPDATED
        break
      case 'PUBLISHED_AT':
        sort.by = SortBy.PUBLISHED
        break
      case 'SAVED_AT':
        sort.by = SortBy.SAVED
        break
    }
  }

  return sort
}

const getColumnName = (field: string) => {
  const lowerCaseField = field.toLowerCase()
  switch (lowerCaseField) {
    case 'language':
      return 'item_language'
    case 'subscription':
    case 'rss':
      return 'subscription'
    case 'site':
      return 'site_name'
    case 'wordscount':
      return 'word_count'
    case 'readposition':
      return 'reading_progress_bottom_percent'
    case 'saved':
    case 'read':
    case 'updated':
    case 'published':
      return `${lowerCaseField}_at`
    case 'author':
    case 'title':
    case 'description':
    case 'note':
      return lowerCaseField
    case 'highlight':
      return 'highlight_annotations'
    case 'label':
      return 'label_names'
    default:
      throw new Error(`Unexpected field: ${field}`)
  }
}

export const buildQuery = (
  searchQuery: LiqeQuery,
  parameters: ObjectLiteral[] = [],
  selects: Select[] = [],
  orders: Sort[] = [],
  useFolders = false
) => {
  const escapeQueryWithParameters = (
    query: string,
    parameter: ObjectLiteral
  ) => {
    parameters.push(parameter)
    return query
  }

  const serializeImplicitField = (
    expression: ExpressionToken
  ): string | null => {
    if (expression.type !== 'LiteralExpression') {
      throw new Error('Expected a literal expression')
    }

    const value = expression.value?.toString()

    if (value === undefined || value === '') {
      return null
    }

    const param = `implicit_field_${parameters.length}`
    const alias = `rank_${parameters.length}`
    selects.push({
      column: `ts_rank_cd(library_item.search_tsv, websearch_to_tsquery('english', :${param}))`,
      alias,
    })

    orders.push({ by: alias, order: SortOrder.DESCENDING })

    return escapeQueryWithParameters(
      `websearch_to_tsquery('english', :${param}) @@ library_item.search_tsv`,
      { [param]: value }
    )
  }

  const serializeTagExpression = (ast: LiqeQuery): string | null => {
    if (ast.type !== 'Tag') {
      throw new Error('Expected a tag expression')
    }

    const { field, expression } = ast

    if (field.type === 'ImplicitField') {
      return serializeImplicitField(expression)
    } else {
      if (expression.type !== 'LiteralExpression') {
        // ignore empty values
        return null
      }

      const value = expression.value?.toString()
      if (!value) {
        // ignore empty values
        return null
      }

      switch (field.name.toLowerCase()) {
        case 'in': {
          switch (value.toLowerCase()) {
            case InFilter.ALL:
              return null
            case InFilter.ARCHIVE:
              return 'library_item.archived_at IS NOT NULL'
            case InFilter.TRASH:
              // return only deleted pages within 14 days
              return "library_item.deleted_at >= now() - interval '14 days'"
            default: {
              let sql = 'library_item.archived_at IS NULL'
              if (useFolders) {
                const param = `folder_${parameters.length}`
                const folderSql = escapeQueryWithParameters(
                  `library_item.folder = :${param}`,
                  { [param]: value }
                )
                sql = `(${sql} AND ${folderSql})`
              }

              return sql
            }
          }
        }

        case 'is': {
          switch (value.toLowerCase()) {
            case ReadFilter.READ:
              return 'library_item.reading_progress_bottom_percent > 98'
            case ReadFilter.READING:
              return 'library_item.reading_progress_bottom_percent BETWEEN 2 AND 98'
            case ReadFilter.UNREAD:
              return 'library_item.reading_progress_bottom_percent < 2'
            default:
              throw new Error(`Unexpected keyword: ${value}`)
          }
        }
        case 'type': {
          const param = `type_${parameters.length}`

          return escapeQueryWithParameters(
            `LOWER(library_item.item_type) = :${param}`,
            {
              [param]: value.toLowerCase(),
            }
          )
        }
        case 'label': {
          const labels = value.toLowerCase().split(',')
          return (
            labels
              .map((label) => {
                const param = `label_${parameters.length}`

                const hasWildcard = label.includes('*')
                if (hasWildcard) {
                  return escapeQueryWithParameters(
                    `exists (select 1 from unnest(array_cat(library_item.label_names, library_item.highlight_labels)::text[]) as label where label ILIKE :${param})`,
                    {
                      [param]: label.replace(/\*/g, '%'),
                    }
                  )
                }

                return escapeQueryWithParameters(
                  `:${param} = ANY(lower(array_cat(library_item.label_names, library_item.highlight_labels)::text)::text[])`,
                  {
                    [param]: label,
                  }
                )
              })
              .join(' OR ')
              // wrap in brackets to avoid precedence issues
              .replace(/^(.*)$/, '($1)')
          )
        }
        case 'sort': {
          const [sort, sortOrder] = value.toLowerCase().split('-')
          const matchingSortBy = Object.values(SortBy).find(
            (sortBy) => sortBy === sort
          )
          if (!matchingSortBy) {
            return null
          }
          const column = getColumnName(matchingSortBy)

          const order =
            sortOrder === 'asc' ? SortOrder.ASCENDING : SortOrder.DESCENDING
          const nulls =
            order === SortOrder.ASCENDING ? 'NULLS FIRST' : 'NULLS LAST'

          orders.push({ by: `library_item.${column}`, order, nulls })
          return null
        }
        case 'has':
          return `NOT (${handleNoCase(value)})`
        case 'saved':
        case 'read':
        case 'updated':
        case 'published': {
          let startDate: Date | undefined
          let endDate: Date | undefined
          // check for special date filters
          switch (value.toLowerCase()) {
            case 'today':
              startDate = DateTime.local().startOf('day').toJSDate()
              break
            case 'yesterday': {
              const yesterday = DateTime.local().minus({ days: 1 })
              startDate = yesterday.startOf('day').toJSDate()
              endDate = yesterday.endOf('day').toJSDate()
              break
            }
            case 'this week':
              startDate = DateTime.local().startOf('week').toJSDate()
              break
            case 'this month':
              startDate = DateTime.local().startOf('month').toJSDate()
              break
            default: {
              // check for date ranges
              const [start, end] = value.split('..')
              // validate date
              if (start && start !== '*') {
                startDate = new Date(start)
                if (isNaN(startDate.getTime())) {
                  throw new Error('Invalid start date')
                }
              }

              if (end && end !== '*') {
                endDate = new Date(end)
                if (isNaN(endDate.getTime())) {
                  throw new Error('Invalid end date')
                }
              }
            }
          }

          const startParam = `${field.name}_start_${parameters.length}`
          const endParam = `${field.name}_end_${parameters.length}`

          return escapeQueryWithParameters(
            `library_item.${field.name}_at BETWEEN :${startParam} AND :${endParam}`,
            {
              [startParam]: startDate ?? new Date(0),
              [endParam]: endDate ?? new Date(),
            }
          )
        }
        // term filters
        case 'subscription':
        case 'rss':
        case 'language': {
          const columnName = getColumnName(field.name)
          const param = `term_${field.name}_${parameters.length}`

          return escapeQueryWithParameters(
            `library_item.${columnName} = :${param}`,
            {
              [param]: value,
            }
          )
        }
        // match filters
        case 'author':
        case 'title':
        case 'description':
        case 'note':
        case 'site': {
          const columnName = getColumnName(field.name)
          const param = `match_${field.name}_${parameters.length}`
          const wildcardParam = `match_${field.name}_wildcard_${parameters.length}`

          return escapeQueryWithParameters(
            `(websearch_to_tsquery('english', :${param}) @@ library_item.${columnName}_tsv OR library_item.${columnName} ILIKE :${wildcardParam})`,
            {
              [param]: value,
              [wildcardParam]: `%${value}%`,
            }
          )
        }
        case 'includes': {
          const ids = value.split(',')
          if (!ids || ids.length === 0) {
            throw new Error('Expected ids')
          }

          const param = `includes_${parameters.length}`

          return escapeQueryWithParameters(`library_item.id = ANY(:${param})`, {
            [param]: ids,
          })
        }
        case 'recommendedby': {
          const param = `recommendedBy_${parameters.length}`
          if (value === '*') {
            // select all if * is provided
            return "library_item.recommender_names <> '{}'"
          }

          return escapeQueryWithParameters(
            `:${param} = ANY(lower(library_item.recommender_names::text)::text[])`,
            {
              [param]: value.toLowerCase(),
            }
          )
        }
        case 'no':
          return handleNoCase(value)
        case 'use':
        case 'mode':
        case 'event':
          // mode is ignored and used only by the frontend
          return null
        case 'readposition':
        case 'wordscount': {
          const column = getColumnName(field.name)

          const operatorRegex = /([<>]=?)/
          const operator = value.match(operatorRegex)?.[0]
          if (!operator) {
            throw new Error('Expected operator')
          }

          const newValue = value.replace(operatorRegex, '')

          const param = `range_${field.name}_${parameters.length}`

          return escapeQueryWithParameters(
            `library_item.${column} ${operator} :${param}`,
            {
              [param]: parseInt(newValue, 10),
            }
          )
        }
        default:
          // treat unknown fields as implicit fields
          return serializeImplicitField({
            ...expression,
            value: `${field.name}:${value}`,
          })
      }
    }
  }

  const serialize = (ast: LiqeQuery): string | null => {
    if (ast.type === 'Tag') {
      return serializeTagExpression(ast)
    }

    if (ast.type === 'LogicalExpression') {
      let operator = ''
      if (ast.operator.operator === 'AND') {
        operator = 'AND'
      } else if (ast.operator.operator === 'OR') {
        operator = 'OR'
      } else {
        throw new Error('Unexpected operator')
      }

      const left = serialize(ast.left)
      const right = serialize(ast.right)

      if (!left && !right) {
        return null
      }

      if (!left) {
        return right
      }

      if (!right) {
        return left
      }

      return `${left} ${operator} ${right}`
    }

    if (ast.type === 'UnaryOperator') {
      const serialized = serialize(ast.operand)

      if (!serialized) {
        return null
      }

      return `NOT ${serialized}`
    }

    if (ast.type === 'ParenthesizedExpression') {
      const serialized = serialize(ast.expression)

      if (!serialized) {
        return null
      }

      return `(${serialized})`
    }

    return null
  }

  return serialize(searchQuery)
}

export const searchLibraryItems = async (
  args: SearchArgs,
  userId: string
): Promise<{ libraryItems: LibraryItem[]; count: number }> => {
  const { from = 0, size = 10 } = args

  // select all columns except content
  const selects: Select[] = getColumns(libraryItemRepository)
    .map((column) => ({ column: `library_item.${column}` }))
    .filter(
      (select) =>
        select.column !== 'library_item.readableContent' &&
        select.column !== 'library_item.originalContent'
    )

  const parameters: ObjectLiteral[] = []
  const orders: Sort[] = []
  let query: string | null = null

  if (args.query) {
    const searchQuery = parseSearchQuery(args.query)

    // build query and save parameters
    query = buildQuery(
      searchQuery,
      parameters,
      selects,
      orders,
      args.useFolders
    )
  }

  // add pagination and sorting
  return authTrx(
    async (tx) => {
      const queryBuilder = tx
        .createQueryBuilder(LibraryItem, 'library_item')
        .where('library_item.user_id = :userId', { userId })

      // add select
      selects.forEach((select) => {
        queryBuilder.addSelect(select.column, select.alias)
      })

      if (!args.includePending) {
        queryBuilder.andWhere("library_item.state <> 'PROCESSING'")
      }

      if (!args.includeDeleted) {
        queryBuilder.andWhere("library_item.state <> 'DELETED'")
      }

      if (query) {
        // add where clause from query
        queryBuilder
          .andWhere(`(${query})`)
          .setParameters(paramtersToObject(parameters))
      }

      const count = await queryBuilder.getCount()

      // default order by saved at descending
      if (!orders.find((order) => order.by === 'library_item.saved_at')) {
        orders.push({
          by: 'library_item.saved_at',
          order: SortOrder.DESCENDING,
          nulls: 'NULLS LAST',
        })
      }

      // add order by
      orders.forEach((order) => {
        queryBuilder.addOrderBy(order.by, order.order, order.nulls)
      })

      const libraryItems = await queryBuilder.skip(from).take(size).getMany()

      return { libraryItems, count }
    },
    undefined,
    userId
  )
}

export const findLibraryItemById = async (
  id: string,
  userId: string
): Promise<LibraryItem | null> => {
  return authTrx(
    async (tx) =>
      tx
        .createQueryBuilder(LibraryItem, 'library_item')
        .leftJoinAndSelect('library_item.labels', 'labels')
        .leftJoinAndSelect('library_item.highlights', 'highlights')
        .leftJoinAndSelect('highlights.user', 'user')
        .where('library_item.id = :id', { id })
        .getOne(),
    undefined,
    userId
  )
}

export const findLibraryItemByUrl = async (
  url: string,
  userId: string
): Promise<LibraryItem | null> => {
  return authTrx(
    async (tx) =>
      tx
        .createQueryBuilder(LibraryItem, 'library_item')
        .leftJoinAndSelect('library_item.labels', 'labels')
        .leftJoinAndSelect('library_item.highlights', 'highlights')
        .leftJoinAndSelect('library_item.recommendations', 'recommendations')
        .leftJoinAndSelect('recommendations.recommender', 'recommender')
        .leftJoinAndSelect('recommender.profile', 'profile')
        .leftJoinAndSelect('recommendations.group', 'group')
        .where('library_item.user_id = :userId', { userId })
        .andWhere('library_item.original_url = :url', { url })
        .getOne(),
    undefined,
    userId
  )
}

export const restoreLibraryItem = async (
  id: string,
  userId: string,
  pubsub = createPubSubClient()
): Promise<LibraryItem> => {
  return updateLibraryItem(
    id,
    {
      state: LibraryItemState.Succeeded,
      savedAt: new Date(),
      archivedAt: null,
      deletedAt: null,
    },
    userId,
    pubsub
  )
}

export const softDeleteLibraryItem = async (
  id: string,
  userId: string,
  pubsub = createPubSubClient()
): Promise<LibraryItem> => {
  const deletedLibraryItem = await authTrx(
    async (tx) => {
      const itemRepo = tx.withRepository(libraryItemRepository)

      // mark item as deleted
      await itemRepo.update(id, {
        state: LibraryItemState.Deleted,
        deletedAt: new Date(),
      })

      return itemRepo.findOneByOrFail({ id })
    },
    undefined,
    userId
  )

  await pubsub.entityDeleted(EntityType.PAGE, id, userId)

  return deletedLibraryItem
}

export const updateLibraryItem = async (
  id: string,
  libraryItem: QueryDeepPartialEntity<LibraryItem>,
  userId: string,
  pubsub = createPubSubClient()
): Promise<LibraryItem> => {
  const updatedLibraryItem = await authTrx(
    async (tx) => {
      const itemRepo = tx.withRepository(libraryItemRepository)

      // reset archivedAt
      switch (libraryItem.state) {
        case LibraryItemState.Archived:
          libraryItem.archivedAt = new Date()
          break
        case LibraryItemState.Processing:
        case LibraryItemState.Succeeded:
          libraryItem.archivedAt = null
          libraryItem.deletedAt = null
          break
      }
      await itemRepo.update(id, libraryItem)

      return itemRepo.findOneByOrFail({ id })
    },
    undefined,
    userId
  )

  await pubsub.entityUpdated<QueryDeepPartialEntity<LibraryItem>>(
    EntityType.PAGE,
    {
      ...libraryItem,
      id,
      // don't send original content and readable content
      originalContent: undefined,
      readableContent: undefined,
    },
    userId
  )

  return updatedLibraryItem
}

export const updateLibraryItemReadingProgress = async (
  id: string,
  userId: string,
  bottomPercent: number,
  topPercent: number | null = null,
  anchorIndex: number | null = null
): Promise<LibraryItem | null> => {
  // If we have a top percent, we only save it if it's greater than the current top percent
  // or set to zero if the top percent is zero.
  const result = (await authTrx(
    async (tx) =>
      tx.getRepository(LibraryItem).query(
        `
      UPDATE omnivore.library_item
      SET reading_progress_top_percent = CASE
        WHEN reading_progress_top_percent < $2 THEN $2
        WHEN $2 = 0 THEN 0
        ELSE reading_progress_top_percent
      END,
      reading_progress_bottom_percent = CASE
        WHEN reading_progress_bottom_percent < $3 THEN $3
        WHEN $3 = 0 THEN 0
        ELSE reading_progress_bottom_percent
      END,
      reading_progress_highest_read_anchor = CASE
        WHEN reading_progress_top_percent < $4 THEN $4
        WHEN $4 = 0 THEN 0
        ELSE reading_progress_highest_read_anchor
      END,
      read_at = now()
      WHERE id = $1 AND (
        (reading_progress_top_percent < $2 OR $2 = 0) OR
        (reading_progress_bottom_percent < $3 OR $3 = 0) OR
        (reading_progress_highest_read_anchor < $4 OR $4 = 0)
      )
      RETURNING
        id,
        reading_progress_top_percent as "readingProgressTopPercent",
        reading_progress_bottom_percent as "readingProgressBottomPercent",
        reading_progress_highest_read_anchor as "readingProgressHighestReadAnchor",
        read_at as "readAt"
      `,
        [id, topPercent, bottomPercent, anchorIndex]
      ),
    undefined,
    userId
  )) as [LibraryItem[], number]
  if (result[1] === 0) {
    return null
  }

  const updatedItem = result[0][0]
  return updatedItem
}

export const createLibraryItems = async (
  libraryItems: DeepPartial<LibraryItem>[],
  userId: string
): Promise<LibraryItem[]> => {
  return authTrx(
    async (tx) => tx.withRepository(libraryItemRepository).save(libraryItems),
    undefined,
    userId
  )
}

export const createLibraryItem = async (
  libraryItem: DeepPartial<LibraryItem>,
  userId: string,
  pubsub = createPubSubClient(),
  skipPubSub = false
): Promise<LibraryItem> => {
  const newLibraryItem = await authTrx(
    async (tx) =>
      tx.withRepository(libraryItemRepository).save({
        ...libraryItem,
        wordCount:
          libraryItem.wordCount ??
          wordsCount(libraryItem.readableContent || ''),
      }),
    undefined,
    userId
  )

  // set recently saved item in redis if redis is enabled
  if (env.redis.url) {
    await setRecentlySavedItemInRedis(userId, newLibraryItem.originalUrl)
  }

  if (skipPubSub) {
    return newLibraryItem
  }

  await pubsub.entityCreated<DeepPartial<LibraryItem>>(
    EntityType.PAGE,
    {
      ...newLibraryItem,
      // don't send original content and readable content
      originalContent: undefined,
      readableContent: undefined,
    },
    userId
  )

  return newLibraryItem
}

export const findLibraryItemsByPrefix = async (
  prefix: string,
  userId: string,
  limit = 5
): Promise<LibraryItem[]> => {
  const prefixWildcard = `${prefix}%`

  return authTrx(async (tx) =>
    tx
      .createQueryBuilder(LibraryItem, 'library_item')
      .where('library_item.user_id = :userId', { userId })
      .andWhere(
        '(library_item.title ILIKE :prefix OR library_item.site_name ILIKE :prefix)',
        { prefix: prefixWildcard }
      )
      .orderBy('library_item.savedAt', 'DESC')
      .limit(limit)
      .getMany()
  )
}

export const countByCreatedAt = async (
  userId: string,
  startDate = new Date(0),
  endDate = new Date()
): Promise<number> => {
  return authTrx(
    async (tx) =>
      tx
        .createQueryBuilder(LibraryItem, 'library_item')
        .where('library_item.user_id = :userId', { userId })
        .andWhere('library_item.created_at between :startDate and :endDate', {
          startDate,
          endDate,
        })
        .getCount(),
    undefined,
    userId
  )
}

export const batchUpdateLibraryItems = async (
  action: BulkActionType,
  searchArgs: SearchArgs,
  userId: string,
  labels?: Label[],
  args?: unknown
) => {
  interface FolderArguments {
    folder: string
  }

  const isFolderArguments = (args: any): args is FolderArguments => {
    return 'folder' in args
  }

  const now = new Date().toISOString()
  // build the script
  let values: Record<string, string | number> = {}
  let addLabels = false
  switch (action) {
    case BulkActionType.Archive:
      values = {
        archived_at: now,
        state: LibraryItemState.Archived,
      }
      break
    case BulkActionType.Delete:
      values = {
        state: LibraryItemState.Deleted,
        deleted_at: now,
      }
      break
    case BulkActionType.AddLabels:
      addLabels = true
      break
    case BulkActionType.MarkAsRead:
      values = {
        read_at: now,
        reading_progress_top_percent: 100,
        reading_progress_bottom_percent: 100,
      }
      break
    case BulkActionType.MoveToFolder:
      if (!args || !isFolderArguments(args)) {
        throw new Error('Invalid arguments')
      }

      values = {
        folder: args.folder,
        saved_at: now,
      }

      break
    default:
      throw new Error('Invalid bulk action')
  }

  if (!searchArgs.query) {
    throw new Error('Search query is required')
  }

  const searchQuery = parseSearchQuery(searchArgs.query)
  const parameters: ObjectLiteral[] = []
  const query = buildQuery(searchQuery, parameters)

  await authTrx(async (tx) => {
    const queryBuilder = tx
      .createQueryBuilder(LibraryItem, 'library_item')
      .where('library_item.user_id = :userId', { userId })

    if (query) {
      queryBuilder
        .andWhere(`(${query})`)
        .setParameters(paramtersToObject(parameters))
    }

    if (addLabels) {
      if (!labels) {
        throw new Error('Labels are required for this action')
      }

      const libraryItems = await queryBuilder.getMany()
      // add labels in library items
      const labelsToAdd = libraryItems.flatMap((libraryItem) =>
        labels
          .map((label) => ({
            labelId: label.id,
            libraryItemId: libraryItem.id,
            name: label.name,
          }))
          .filter((entityLabel) => {
            const existingLabel = libraryItem.labelNames?.find(
              (l) => l.toLowerCase() === entityLabel.name.toLowerCase()
            )
            return !existingLabel
          })
      )
      return tx.getRepository(EntityLabel).save(labelsToAdd)
    }

    // generate raw sql because postgres doesn't support prepared statements in DO blocks
    const countSql = queryBuilderToRawSql(queryBuilder.select('COUNT(1)'))
    const subQuery = queryBuilderToRawSql(queryBuilder.select('id'))
    const valuesSql = valuesToRawSql(values)

    const start = new Date().toISOString()
    const batchSize = 1000
    const sql = `
    -- Set batch size
    DO $$ 
    DECLARE 
        batch_size INT := ${batchSize};
    BEGIN
        -- Loop through batches
        FOR i IN 0..CEIL((${countSql}) * 1.0 / batch_size) - 1 LOOP
            -- Update the batch
            UPDATE omnivore.library_item
            SET ${valuesSql}
            WHERE id = ANY(
              ${subQuery}
              AND updated_at < '${start}'
              LIMIT batch_size
            );
        END LOOP;
    END $$
    `

    return tx.query(sql)
  })
}

export const deleteLibraryItemById = async (id: string, userId?: string) => {
  return authTrx(
    async (tx) => tx.withRepository(libraryItemRepository).delete(id),
    undefined,
    userId
  )
}

export const deleteLibraryItems = async (
  items: LibraryItem[],
  userId?: string
) => {
  return authTrx(
    async (tx) => tx.withRepository(libraryItemRepository).remove(items),
    undefined,
    userId
  )
}

export const deleteLibraryItemByUrl = async (url: string, userId: string) => {
  return authTrx(
    async (tx) =>
      tx
        .withRepository(libraryItemRepository)
        .delete({ originalUrl: url, user: { id: userId } }),
    undefined,
    userId
  )
}

export const deleteLibraryItemsByUserId = async (userId: string) => {
  return authTrx(
    async (tx) =>
      tx.withRepository(libraryItemRepository).delete({
        user: { id: userId },
      }),
    undefined,
    userId
  )
}

export const deleteLibraryItemsByAdmin = async (
  criteria: FindOptionsWhere<LibraryItem>
) => {
  return authTrx(
    async (tx) => tx.withRepository(libraryItemRepository).delete(criteria),
    undefined,
    undefined,
    'admin'
  )
}

export const batchDelete = async (criteria: FindOptionsWhere<LibraryItem>) => {
  const batchSize = 1000

  const qb = libraryItemRepository.createQueryBuilder().where(criteria)
  const countSql = queryBuilderToRawSql(qb.select('COUNT(1)'))
  const subQuery = queryBuilderToRawSql(qb.select('id').limit(batchSize))

  const sql = `
  -- Set batch size
  DO $$
  DECLARE 
      batch_size INT := ${batchSize};
  BEGIN
      -- Loop through batches
      FOR i IN 0..CEIL((${countSql}) * 1.0 / batch_size) - 1 LOOP
          -- Delete batch
          DELETE FROM omnivore.library_item
          WHERE id = ANY(
            ${subQuery}
          );
      END LOOP;
  END $$
  `

  return authTrx(async (t) => t.query(sql))
}

export const recreateLibraryItem = async (
  id: string,
  userId: string,
  existingItemState: LibraryItemState,
  itemToSave: DeepPartial<LibraryItem>,
  pubsub = createPubSubClient()
) => {
  // update the item except for id and slug
  const updatedItem = await updateLibraryItem(
    id,
    {
      ...itemToSave,
      id: undefined,
      slug: undefined,
    } as QueryDeepPartialEntity<LibraryItem>,
    userId,
    pubsub
  )

  try {
    // delete labels and highlights if the item was deleted
    if (existingItemState === LibraryItemState.Deleted) {
      logger.info('Deleting labels and highlights for item', { id })
      await authTrx(async (t) => {
        await t.getRepository(Highlight).delete({
          libraryItem: { id },
        })

        await t.getRepository(EntityLabel).delete({
          libraryItemId: id,
        })
      })
    }
  } catch (error) {
    // continue to save the item even if we failed to delete labels and highlights
    logger.error('Failed to delete labels and highlights', error)
  }

  return updatedItem
}
