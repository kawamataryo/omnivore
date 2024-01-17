import { Readability } from '@omnivore/readability'
import { DeepPartial } from 'typeorm'
import { Highlight } from '../entity/highlight'
import { LibraryItem, LibraryItemState } from '../entity/library_item'
import { User } from '../entity/user'
import { homePageURL } from '../env'
import {
  ArticleSavingRequestStatus,
  Maybe,
  PreparedDocumentInput,
  SaveErrorCode,
  SavePageInput,
  SaveResult,
} from '../generated/graphql'
import { authTrx } from '../repository'
import { enqueueThumbnailTask } from '../utils/createTask'
import {
  cleanUrl,
  generateSlug,
  stringToHash,
  TWEET_URL_REGEX,
  validatedDate,
  wordsCount,
} from '../utils/helpers'
import { logger } from '../utils/logger'
import { parsePreparedContent } from '../utils/parser'
import { contentReaderForLibraryItem } from '../utils/uploads'
import { createPageSaveRequest } from './create_page_save_request'
import { createHighlight } from './highlights'
import { createAndAddLabelsToLibraryItem } from './labels'
import { createLibraryItem, recreateLibraryItem } from './library_item'

// where we can use APIs to fetch their underlying content.
const FORCE_PUPPETEER_URLS = [
  TWEET_URL_REGEX,
  /^((?:https?:)?\/\/)?((?:www|m)\.)?((?:youtube\.com|youtu.be))(\/(?:[\w-]+\?v=|embed\/|v\/)?)([\w-]+)(\S+)?$/,
]
const ALREADY_PARSED_SOURCES = [
  'puppeteer-parse',
  'csv-importer',
  'rss-feeder',
  'pocket',
]

const createSlug = (url: string, title?: Maybe<string> | undefined) => {
  const { pathname } = new URL(url)
  const croppedPathname = decodeURIComponent(
    pathname
      .split('/')
      [pathname.split('/').length - 1].split('.')
      .slice(0, -1)
      .join('.')
  ).replace(/_/gi, ' ')

  return [generateSlug(title || croppedPathname), croppedPathname]
}

const shouldParseInBackend = (input: SavePageInput): boolean => {
  return (
    ALREADY_PARSED_SOURCES.indexOf(input.source) === -1 &&
    FORCE_PUPPETEER_URLS.some((regex) => regex.test(input.url))
  )
}

export const savePage = async (
  input: SavePageInput,
  user: User
): Promise<SaveResult> => {
  const parseResult = await parsePreparedContent(
    input.url,
    {
      document: input.originalContent,
      pageInfo: {
        title: input.title,
        canonicalUrl: input.url,
      },
    },
    input.parseResult
  )
  const [newSlug, croppedPathname] = createSlug(input.url, input.title)
  let slug = newSlug
  let clientRequestId = input.clientRequestId

  const itemToSave = parsedContentToLibraryItem({
    itemId: clientRequestId,
    url: input.url,
    title: input.title,
    userId: user.id,
    slug,
    croppedPathname,
    parsedContent: parseResult.parsedContent,
    itemType: parseResult.pageType,
    originalHtml: parseResult.domContent,
    canonicalUrl: parseResult.canonicalUrl,
    savedAt: input.savedAt ? new Date(input.savedAt) : new Date(),
    publishedAt: input.publishedAt ? new Date(input.publishedAt) : undefined,
    state: input.state || undefined,
    rssFeedUrl: input.rssFeedUrl,
    folder: input.folder,
  })
  const isImported =
    input.source === 'csv-importer' || input.source === 'pocket'

  // always parse in backend if the url is in the force puppeteer list
  if (shouldParseInBackend(input)) {
    try {
      await createPageSaveRequest({
        userId: user.id,
        url: itemToSave.originalUrl,
        articleSavingRequestId: clientRequestId || undefined,
        state: input.state || undefined,
        labels: input.labels || undefined,
        folder: input.folder || undefined,
      })
    } catch (e) {
      return {
        errorCodes: [SaveErrorCode.Unknown],
        message: 'Failed to create page save request',
      }
    }
  } else {
    // check if the item already exists
    const existingLibraryItem = await authTrx((t) =>
      t.getRepository(LibraryItem).findOneBy({
        user: { id: user.id },
        originalUrl: itemToSave.originalUrl,
      })
    )
    if (existingLibraryItem) {
      clientRequestId = existingLibraryItem.id
      slug = existingLibraryItem.slug

      // we don't want to update an rss feed item if rss-feeder is tring to re-save it
      if (existingLibraryItem.subscription === input.rssFeedUrl) {
        return {
          clientRequestId,
          url: `${homePageURL()}/${user.profile.username}/${slug}`,
        }
      }

      await recreateLibraryItem(
        clientRequestId,
        user.id,
        existingLibraryItem.state,
        itemToSave
      )
    } else {
      // do not publish a pubsub event if the item is imported
      const newItem = await createLibraryItem(
        itemToSave,
        user.id,
        undefined,
        isImported
      )
      clientRequestId = newItem.id
    }

    // merge labels
    await createAndAddLabelsToLibraryItem(
      clientRequestId,
      user.id,
      input.labels,
      input.rssFeedUrl
    )
  }

  // we don't want to create thumbnail for imported pages
  if (!isImported) {
    try {
      // create a task to update thumbnail and pre-cache all images
      const taskId = await enqueueThumbnailTask(user.id, slug)
      logger.info('Created thumbnail task', { taskId })
    } catch (e) {
      logger.error('Failed to create thumbnail task', e)
    }
  }

  if (parseResult.highlightData) {
    const highlight: DeepPartial<Highlight> = {
      ...parseResult.highlightData,
      user: { id: user.id },
      libraryItem: { id: clientRequestId },
    }

    // merge highlights
    if (!(await createHighlight(highlight, clientRequestId, user.id))) {
      return {
        errorCodes: [SaveErrorCode.EmbeddedHighlightFailed],
        message: 'Failed to save highlight',
      }
    }
  }

  return {
    clientRequestId,
    url: `${homePageURL()}/${user.profile.username}/${slug}`,
  }
}

// convert parsed content to an library item
export const parsedContentToLibraryItem = ({
  url,
  userId,
  originalHtml,
  itemId,
  parsedContent,
  slug,
  croppedPathname,
  title,
  preparedDocument,
  canonicalUrl,
  itemType,
  uploadFileHash,
  uploadFileId,
  savedAt,
  publishedAt,
  state,
  rssFeedUrl,
  folder,
}: {
  url: string
  userId: string
  slug: string
  croppedPathname: string
  itemType: string
  parsedContent: Readability.ParseResult | null
  originalHtml?: string | null
  itemId?: string | null
  title?: string | null
  preparedDocument?: PreparedDocumentInput | null
  canonicalUrl?: string | null
  uploadFileHash?: string | null
  uploadFileId?: string | null
  savedAt?: Date
  publishedAt?: Date | null
  state?: ArticleSavingRequestStatus | null
  rssFeedUrl?: string | null
  folder?: string | null
}): DeepPartial<LibraryItem> & { originalUrl: string } => {
  return {
    id: itemId || undefined,
    slug,
    user: { id: userId },
    originalContent: originalHtml,
    readableContent: parsedContent?.content || '',
    description: parsedContent?.excerpt,
    title:
      title ||
      parsedContent?.title ||
      preparedDocument?.pageInfo.title ||
      croppedPathname ||
      parsedContent?.siteName ||
      url,
    author: parsedContent?.byline,
    originalUrl: cleanUrl(canonicalUrl || url),
    itemType,
    textContentHash:
      uploadFileHash || stringToHash(parsedContent?.content || url),
    thumbnail: parsedContent?.previewImage ?? undefined,
    publishedAt: validatedDate(
      publishedAt || parsedContent?.publishedDate || undefined
    ),
    uploadFileId: uploadFileId || undefined,
    readingProgressTopPercent: 0,
    readingProgressHighestReadAnchor: 0,
    state: state
      ? (state as unknown as LibraryItemState)
      : LibraryItemState.Succeeded,
    savedAt: validatedDate(savedAt),
    siteName: parsedContent?.siteName,
    itemLanguage: parsedContent?.language,
    siteIcon: parsedContent?.siteIcon,
    wordCount: wordsCount(parsedContent?.textContent || ''),
    contentReader: contentReaderForLibraryItem(itemType, uploadFileId),
    subscription: rssFeedUrl,
    folder: folder || 'inbox',
    archivedAt:
      state === ArticleSavingRequestStatus.Archived ? new Date() : null,
  }
}
