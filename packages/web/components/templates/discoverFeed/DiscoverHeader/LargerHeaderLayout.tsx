import { HStack, VStack } from '../../../elements/LayoutPrimitives'
import { TopicBar } from './TopicBar'
import { Button } from '../../../elements/Button'
import { GridViewIcon } from '../../../elements/icons/GridViewIcon'
import { PrimaryDropdown } from '../../PrimaryDropdown'
import { DiscoverHeaderProps } from './DiscoverHeader'
import { HeaderText } from './HeaderText'
import React from 'react'
import { ListViewIcon } from '../../../elements/icons/ListViewIcon'
import { PinnedFeeds } from "./PinnedFeeds"

export function LargeHeaderLayout(props: DiscoverHeaderProps): JSX.Element {
  return (
    <HStack
      alignment="center"
      distribution="center"
      css={{
        width: '100%',
        height: '100%',
        '@mdDown': {
          display: 'none',
        },
      }}
    >
      <VStack alignment={'center'} distribution={'center'}>
        <HStack
          alignment="center"
          distribution={'start'}
          css={{
            gap: '10px',
            width: '95%',
            '@mdDown': {
              width: '95%',
              display: 'none',
            },
            '@media (min-width: 930px)': {
              width: '660px',
            },
            '@media (min-width: 1280px)': {
              width: '1000px',
            },
            '@media (min-width: 1600px)': {
              width: '1340px',
            },
          }}
        >
          <TopicBar
            setActiveTab={props.setActiveTab}
            activeTab={props.activeTab}
            topics={props.topics}
          />
          <Button
            style="plainIcon"
            css={{ display: 'flex', marginLeft: 'auto' }}
            onClick={(e) => {
              props.setLayoutType(
                props.layout == 'GRID_LAYOUT' ? 'LIST_LAYOUT' : 'GRID_LAYOUT'
              )
              e.preventDefault()
            }}
          >
            {props.layout == 'GRID_LAYOUT' ? (
              <ListViewIcon size={30} color={'#898989'} />
            ) : (
              <GridViewIcon size={30} color={'#898989'} />
            )}
          </Button>
          <PrimaryDropdown
            showThemeSection={true}
            showAddLinkModal={() => props.setShowAddLinkModal(true)}
          />
        </HStack>
        <HStack
          alignment="center"
          distribution={'start'}
          css={{
            gap: '10px',
            width: '95%',
            paddingBottom: '5px',
            '@mdDown': {
              width: '95%',
              display: 'none',
            },
            '@media (min-width: 930px)': {
              width: '660px',
            },
            '@media (min-width: 1280px)': {
              width: '1000px',
            },
            '@media (min-width: 1600px)': {
              width: '1340px',
            },
          }}
        >
          <PinnedFeeds items={props.feeds} selected={props.selectedFeedFilter} applyFeedFilter={props.applyFeedFilter} />
        </HStack>
      </VStack>
    </HStack>
  )
}
