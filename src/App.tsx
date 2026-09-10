import React, { useCallback, useState, useEffect, useMemo, useRef } from "react"
import './App.css'
import moment from 'moment'

import BigNumber from "bignumber.js"
import VisNetworkReactComponent from "vis-network-react"
import { Range, getTrackBackground } from 'react-range'
import Modal from 'react-modal'

import { Option } from 'react-dropdown';

import hljs from 'highlight.js'
import 'highlight.js/styles/default.css'
import 'vis-network/styles/vis-network.min.css'

import testData from './testData.json'
import testDataGloas from './testDataGloas.json'
import { fetchNodeParams, normalizeBaseUrl } from './beaconApi'
import { fetchForkChoice, forkChoiceNodeKey, resolveParentKey, isV2Node, ptcVoteFractions, ForkChoiceApiVersion, PayloadStatus } from './forkChoiceApi'
import { makePtcNodeRenderer, makeEmptyNodeRenderer } from './ptcNode'
import PtcLegend from './PtcLegend'
import ErrorPanel, { ActiveErrors } from './ErrorPanel'

const SLOT_WIDTH: number = 150
// Layout levels are taken relative to an anchor slot so canvas coordinates stay small: mainnet
// slots (~15M) times the level separation exceed the ~16M precision limit of canvas floats and
// render as jagged shapes. The anchor is a coarse multiple so it rarely moves between polls.
const LEVEL_ANCHOR_GRANULARITY: number = 2048
const DEFAULT_SLOTS_PER_EPOCH: number = 32
const DEFAULT_SECONDS_PER_SLOT: number = 12

const FAR_FUTURE_SLOT = '18446744073709551615'

const MAINNET_GENESIS_TIME: number = 1606824023
const GOERLI_GENESIS_TIME: number = 1616508000
const SEPOLIA_GENESIS_TIME: number = 1655733600

const DEFAULT_POLLING_PERIOD: number = 6000
const DEFAULT_ENDPOINT: string = 'http://localhost:5051'
const DEFAULT_POLL_MAX_HISTORY: number = 50

const pollActiveAtStartup: boolean = false

enum SourceType {
  teku = 'Teku (22.12.0 or earlier)',
  prysm = 'Prysm (deprecated)',
  nimbus = 'Nimbus (deprecated)',
  standard = 'Standard'
}

enum NetworkType {
  auto = 'Auto (read from node)',
  mainnet = 'Mainnet',
  goerli = 'Goerli',
  sepolia = 'Sepolia',
  custom = 'Custom'
}

enum NodeSizeMode {
  nodeOnlyWeight = 'node only weight',
  rootToHeadsCumulated = 'root → heads cumulation',
  HeadsToRootCumulated = 'root ← heads cumulation'
}

type ValidationStatus = 'INVALID' | 'OPTIMISTIC' | 'VALID'

type BaseVisNode = {
  id: string
  title: HTMLDivElement
  label: string
  // hierarchical layout level: slot * 2 for block nodes, slot * 2 + 1 for Gloas payload (empty/full) nodes
  level: number
  slot: number
  value: number
  color: string
  shapeProperties?: { borderDashes?: boolean | number[] }
  shape?: string
  ctxRenderer?: any
}

type ExistingNetworkNode = BaseVisNode & {
  forkchoiceNode: any
  isMerge: boolean
  isFirstPOS: boolean
  // graph key of the parent node (block root, or block root + payload status for Gloas v2 nodes)
  parentRoot: string
  payloadStatus?: PayloadStatus
  isRoot: boolean
  isHead: boolean
  weight: BigNumber
  validationStatus: ValidationStatus
  cumulativeToRootWeight: BigNumber
  cumulativeToHeadWeight: BigNumber
  childs: ExistingNetworkNode[]
  isMissingSlot: false
  isLate: boolean
}

type MissingNetworkNode = BaseVisNode & {
  // shapeProperties: {borderDashes: true},
  choosen: false,
  isMissingSlot: true
}

type NetworkNode = ExistingNetworkNode | MissingNetworkNode

type IdToNetworkNode = {
  [id: string]: NetworkNode;
};


const DEFAULT_NODE_SIZE_MODE: NodeSizeMode = NodeSizeMode.rootToHeadsCumulated
const DEFAULT_SOURCE_TYPE: SourceType = SourceType.standard
const DEFAULT_NETWORK_TYPE: NetworkType = NetworkType.auto
// URL parameters (handy for demos, bookmarks and screenshots):
//   ?network=auto|mainnet|goerli|sepolia|custom   initial network (a fixed one skips node detection)
//   ?sample=gloas|teku                            load a bundled dump on start
//   ?zoom=0.7                                     zoom scale re-applied whenever the view centers on the head
//   ?settings=1                                   open the settings dialog on start
function networkTypeFromUrl(): NetworkType | undefined {
  const key = new URLSearchParams(window.location.search).get('network') as keyof typeof NetworkType | null
  return key && key in NetworkType ? NetworkType[key] : undefined
}
function genesisTimeFor(network: NetworkType): number {
  switch (network) {
    case NetworkType.goerli: return GOERLI_GENESIS_TIME
    case NetworkType.sepolia: return SEPOLIA_GENESIS_TIME
    default: return MAINNET_GENESIS_TIME
  }
}
const INITIAL_NETWORK_TYPE: NetworkType = networkTypeFromUrl() ?? DEFAULT_NETWORK_TYPE
const INITIAL_GENESIS_TIME: number = genesisTimeFor(INITIAL_NETWORK_TYPE)
const INITIAL_SHOW_SETTINGS: boolean = new URLSearchParams(window.location.search).get('settings') === '1'
const INITIAL_ZOOM: number | undefined = (() => {
  const zoom = Number(new URLSearchParams(window.location.search).get('zoom'))
  return Number.isFinite(zoom) && zoom > 0 ? zoom : undefined
})()
const DEFAULT_DRAW_MISSING_SLOT_NODES: boolean = true
const DEFAULT_HIDE_EMPTY_NODES: boolean = true
// childless EMPTY nodes below this share (%) of their block's weight are hidden
const DEFAULT_HIDE_EMPTY_THRESHOLD: number = 1
const DEFAULT_PTC_SIZE: number = 512 // mainnet Payload Timeliness Committee size
const DEFAULT_PHYSICS: boolean = true

type ForckchoiceDump = {
  timestamp: moment.Moment
  forkchoiceNodes: any[]

  // allow additional params
  [x: string | number | symbol]: unknown
}

const defaultdata = {
  nodes: [
  ],
  edges: [
  ],
}

function weightToNodeValue(weight: BigNumber) {
  return weight.dividedBy(10000).toNumber()
}

function htmlTitle(html) {
  const container = document.createElement("div")
  container.style.cssText = 'text-align: left;'
  container.innerHTML = html
  return container
}


function validationStatusToColor(validationStatus: ValidationStatus, isHead: boolean) {
  switch (validationStatus) {
    case 'INVALID':
      return isHead ? '#E00000' : '#800000'
    case 'OPTIMISTIC':
      return isHead ? '#E0E0E0' : '#808080'
    case 'VALID':
      return isHead ? '#00E000' : '#008000'
    default: // unknown
      return isHead ? '#202020' : '#000000'
  }
}

function isRealSlot(slot: number) {
  return slot < Number(FAR_FUTURE_SLOT)
}

function slotToLevel(slot: number, anchorSlot: number, payloadNode: boolean = false) {
  return (slot - anchorSlot) * 2 + (payloadNode ? 1 : 0)
}

function createMissingSlotNode(slot: number, anchorSlot: number, parent: NetworkNode, child: NetworkNode) {
  return {
    id: slot + '_' + child.id,
    title: htmlTitle('missing'),
    label: '',
    level: slotToLevel(slot, anchorSlot),
    slot: slot,
    shape: 'diamond',
    scaling: { min: 5, max: 5 },
    choosen: false,
    isMissingSlot: true,
    size: 5,
    value: 0,
    color: '#404040',
  }
}

function timestampToSlot(genesisTime: number, secondsPerSlot: number, timestamp: number) {
  return (+timestamp - genesisTime) / secondsPerSlot;
}

function slotToTimestamp(genesisTime: number, secondsPerSlot: number, slot: number) {
  return +genesisTime + (slot * secondsPerSlot)
}

/**
 * 
 * Teku Specific
 * prerequisites:
 *  node.id must be blockRoot
 *  node.level must set as its slot
 *  node.value must be proportional to its weight
 *  node.color should reflect validation status
 */

function forkchoiceNodeToNetworkNode_Teku(forkchoiceNode): NetworkNode {
  let isMerge = forkchoiceNode.executionBlockHash !== '0x0000000000000000000000000000000000000000000000000000000000000000'
  let label = isMerge ? '🐼 ' : ''
  let cumulativeToRootWeight = BigNumber(forkchoiceNode.weight)
  label += forkchoiceNode.blockRoot.substring(0, 8)
  return {
    id: forkchoiceNode.blockRoot,
    title: htmlTitle('<i>single-click to copy blockRoot, double-click to copy all</i><pre><code id="jsonNodeInfo" class="language-json">' + JSON.stringify(forkchoiceNode, null, ' ') + '</code></pre>'),
    label: label,
    level: parseInt(forkchoiceNode.slot) * 2,
    slot: parseInt(forkchoiceNode.slot),
    value: 0,
    color: validationStatusToColor(forkchoiceNode.validationStatus, false),
    forkchoiceNode: forkchoiceNode,
    isMerge: isMerge,
    isLate: false,
    isFirstPOS: false,
    parentRoot: forkchoiceNode.parentRoot,
    isRoot: false,
    isHead: false,
    isMissingSlot: false,
    validationStatus: forkchoiceNode.validationStatus,
    cumulativeToRootWeight: cumulativeToRootWeight,
    cumulativeToHeadWeight: BigNumber(0),
    weight: BigNumber(0),
    childs: []
  }
}

function forkchoiceNodeToNetworkNode_Prysm(forkchoiceNode): NetworkNode {
  let isMerge = forkchoiceNode.execution_payload !== '0x0000000000000000000000000000000000000000000000000000000000000000'
  let label = isMerge ? '🐼 ' : ''
  let cumulativeToRootWeight = BigNumber(forkchoiceNode.weight)
  label += forkchoiceNode.root.substring(0, 8)
  let validationStatus: ValidationStatus = forkchoiceNode.execution_optimistic ? 'OPTIMISTIC' : 'VALID'
  return {
    id: forkchoiceNode.root,
    title: htmlTitle('<i>single-click to copy blockRoot, double-click to copy all</i><pre><code id="jsonNodeInfo" class="language-json">' + JSON.stringify(forkchoiceNode, null, ' ') + '</code></pre>'),
    label: label,
    level: parseInt(forkchoiceNode.slot) * 2,
    slot: parseInt(forkchoiceNode.slot),
    value: 0,
    color: validationStatusToColor(validationStatus, false),
    forkchoiceNode: forkchoiceNode,
    isMerge: isMerge,
    isLate: false,
    isFirstPOS: false,
    parentRoot: forkchoiceNode.parent_root,
    isRoot: false,
    isHead: false,
    isMissingSlot: false,
    validationStatus: validationStatus,
    cumulativeToRootWeight: cumulativeToRootWeight,
    cumulativeToHeadWeight: BigNumber(0),
    weight: BigNumber(0),
    childs: []
  }
}

function forkchoiceNodeToNetworkNode_Numbus(forkchoiceNode): NetworkNode | undefined {
  if (forkchoiceNode.slot === FAR_FUTURE_SLOT) return
  let isMerge = forkchoiceNode.execution_payload_root !== '0x0000000000000000000000000000000000000000000000000000000000000000'
  let label = isMerge ? '🐼 ' : ''
  let cumulativeToRootWeight = BigNumber(forkchoiceNode.weight)
  label += forkchoiceNode.block_root.substring(0, 8)
  let validationStatus: ValidationStatus = forkchoiceNode.execution_optimistic ? 'OPTIMISTIC' : 'VALID'
  return {
    id: forkchoiceNode.block_root,
    title: htmlTitle('<i>single-click to copy blockRoot, double-click to copy all</i><pre><code id="jsonNodeInfo" class="language-json">' + JSON.stringify(forkchoiceNode, null, ' ') + '</code></pre>'),
    label: label,
    level: parseInt(forkchoiceNode.slot) * 2,
    slot: parseInt(forkchoiceNode.slot),
    value: 0,
    color: validationStatusToColor(validationStatus, false),
    forkchoiceNode: forkchoiceNode,
    isMerge: isMerge,
    isLate: false,
    isFirstPOS: false,
    parentRoot: forkchoiceNode.parent_root,
    isRoot: false,
    isHead: false,
    isMissingSlot: false,
    validationStatus: validationStatus,
    cumulativeToRootWeight: cumulativeToRootWeight,
    cumulativeToHeadWeight: BigNumber(0),
    weight: BigNumber(0),
    childs: []
  }
}

function applyPayloadNodeStyle(node: ExistingNetworkNode, anchorSlot: number, ptcSize: number) {
  const forkchoiceNode = node.forkchoiceNode
  node.level = slotToLevel(node.slot, anchorSlot, true)
  if (node.payloadStatus === 'full') {
    node.label = '🦫 ' + forkchoiceNode.execution_block_hash.substring(0, 8)
    node.shape = 'custom'
    node.ctxRenderer = makePtcNodeRenderer(ptcVoteFractions(forkchoiceNode, ptcSize))
  } else {
    node.label = ''
    node.shape = 'custom'
    node.ctxRenderer = makeEmptyNodeRenderer()
  }
}

function forkchoiceNodeToNetworkNode_Standard(forkchoiceNode): NetworkNode | undefined {
  if (forkchoiceNode.slot === FAR_FUTURE_SLOT) return
  let isMerge = forkchoiceNode.execution_block_hash !== '0x0000000000000000000000000000000000000000000000000000000000000000'
  const payloadStatus: PayloadStatus | undefined = isV2Node(forkchoiceNode) ? forkchoiceNode.payload_status : undefined
  // Panda marks post-merge blocks that carry their own payload: v1 nodes and lone pre-Gloas "full"
  // nodes. Gloas PENDING/EMPTY nodes get none; Gloas FULL nodes are restyled to the beaver by
  // applyPayloadNodeStyle once their PENDING sibling is known.
  const carriesPayload = isMerge && payloadStatus !== 'pending' && payloadStatus !== 'empty'
  let label = (carriesPayload ? '🐼 ' : '') + forkchoiceNode.block_root.substring(0, 8)
  let cumulativeToRootWeight = BigNumber(forkchoiceNode.weight)
  let validationStatus: ValidationStatus = forkchoiceNode.validity.toUpperCase()
  return {
    id: forkChoiceNodeKey(forkchoiceNode),
    payloadStatus: payloadStatus,
    title: htmlTitle('<i>single-click to copy blockRoot, double-click to copy all</i><pre><code id="jsonNodeInfo" class="language-json">' + JSON.stringify(forkchoiceNode, null, ' ') + '</code></pre>'),
    label: label,
    level: parseInt(forkchoiceNode.slot) * 2,
    slot: parseInt(forkchoiceNode.slot),
    value: 0,
    color: validationStatusToColor(validationStatus, false),
    forkchoiceNode: forkchoiceNode,
    isMerge: isMerge,
    isLate: false,
    isFirstPOS: false,
    parentRoot: forkchoiceNode.parent_root,
    isRoot: false,
    isHead: false,
    isMissingSlot: false,
    validationStatus: validationStatus,
    cumulativeToRootWeight: cumulativeToRootWeight,
    cumulativeToHeadWeight: BigNumber(0),
    weight: BigNumber(0),
    childs: []
  }
}


function changeNodeSizeMode(node: ExistingNetworkNode, mode: NodeSizeMode) {

  switch (mode) {
    case NodeSizeMode.nodeOnlyWeight:
      node.value = weightToNodeValue(node.weight)
      break
    case NodeSizeMode.HeadsToRootCumulated:
      node.value = weightToNodeValue(node.cumulativeToRootWeight)
      break
    case NodeSizeMode.rootToHeadsCumulated:
      node.value = weightToNodeValue(node.cumulativeToHeadWeight)
  }

  return node;
}


function calculateCumulativeToHeadWeights(root: ExistingNetworkNode): ExistingNetworkNode[] {
  if (root.childs.length === 0) {
    return [root]
  } else {
    let heads: ExistingNetworkNode[] = []
    root.childs.forEach(child => {
      child.cumulativeToHeadWeight = root.cumulativeToHeadWeight.plus(child.weight)
      heads = [...heads, ...calculateCumulativeToHeadWeights(child)]
    })
    return heads
  }
}

function forkchoiceNodesToNetworkData(
  genesisTime: number,
  secondsPerSlot: number,
  forckchoiceNodes,
  sourceType: SourceType,
  nodeSizeMode: NodeSizeMode,
  drawMissingSlotNodes: boolean,
  hideEmptyNodes: boolean,
  hideEmptyThresholdPercent: number,
  ptcSize: number) {

  let nodes: IdToNetworkNode = {}
  let edges: any = []
  let heads: ExistingNetworkNode[] = []
  let lateNodes: ExistingNetworkNode[] = []
  let headsIds: any = []
  let roots: any = {}
  let firstPOSNode: any

  let rootBlockAttr
  let mapper
  switch (sourceType) {
    case SourceType.teku:
      rootBlockAttr = 'blockRoot'
      mapper = forkchoiceNodeToNetworkNode_Teku
      break;
    case SourceType.prysm:
      rootBlockAttr = 'root'
      mapper = forkchoiceNodeToNetworkNode_Prysm
      break;
    case SourceType.nimbus:
      rootBlockAttr = 'block_root'
      mapper = forkchoiceNodeToNetworkNode_Numbus
      break;
    case SourceType.standard:
      rootBlockAttr = 'block_root'
      mapper = forkchoiceNodeToNetworkNode_Standard

  }

  // Gloas v2: several fork choice nodes may share a block root (pending/empty/full)
  const variantsByRoot: { [root: string]: any[] } = {}
  forckchoiceNodes.forEach(forckchoiceNode => {
    const root = forckchoiceNode[rootBlockAttr]
    variantsByRoot[root] = [...(variantsByRoot[root] ?? []), forckchoiceNode]
  })
  const variantsOfRoot = (root: string) => variantsByRoot[root] ?? []

  const slots = forckchoiceNodes.map(n => parseInt(n.slot)).filter(slot => Number.isFinite(slot) && isRealSlot(slot))
  const anchorSlot = slots.length > 0 ? Math.floor(Math.min(...slots) / LEVEL_ANCHOR_GRANULARITY) * LEVEL_ANCHOR_GRANULARITY : 0

  forckchoiceNodes.forEach(forckchoiceNode => {
    let node = mapper(forckchoiceNode)
    if (node === undefined) return
    node.level = slotToLevel(node.slot, anchorSlot)
    if (sourceType === SourceType.standard) {
      node.parentRoot = resolveParentKey(forckchoiceNode, variantsOfRoot)
      if ((node.payloadStatus === 'empty' || node.payloadStatus === 'full') && node.parentRoot === `${forckchoiceNode.block_root}:pending`) {
        applyPayloadNodeStyle(node as ExistingNetworkNode, anchorSlot, ptcSize)
      }
    }
    nodes[node.id] = node
    headsIds.push(node.id)
  })

  // first pass: set additional flags and find roots and define edges
  Object.keys(nodes).forEach(nodeId => {
    let node = nodes[nodeId];
    if (node.isMissingSlot) return
    delete headsIds[node.parentRoot]

    let parent = nodes[node.parentRoot] as ExistingNetworkNode
    if (parent === undefined) {
      roots[node.id] = nodes[node.id]
    } else {
      parent.childs.push(node)
    }

    if (parent === undefined) {
      node.isFirstPOS = false
      return
    }

    if (drawMissingSlotNodes) {
      // generate missing nodes and connect node to parent
      let lastChild = node as NetworkNode
      for (let slot = node.slot - 1; slot > parent.slot; slot--) {
        let newChild = createMissingSlotNode(slot, anchorSlot, parent, node) as NetworkNode
        nodes[newChild.id] = newChild
        edges.push({ from: lastChild.id, to: newChild.id, arrows: '' })
        lastChild = newChild
      }
      edges.push({ from: lastChild.id, to: parent.id })
    } else {
      edges.push({ from: nodeId, to: parent.id })
    }

    if (parent.isMerge === false && node.isMerge === true) {
      node.isFirstPOS = true
      firstPOSNode = node
    } else {
      node.isFirstPOS = false
    }
  })

  // calculate node weights from the CumulativeToRoot
  Object.keys(nodes).forEach(nodeId => {
    var node = nodes[nodeId] as ExistingNetworkNode;
    if (node.isMissingSlot) return
    node.weight = node.cumulativeToRootWeight;
    node.childs.forEach(child => {
      node.weight = node.weight.minus(child.cumulativeToRootWeight);
    })

    // calculate late nodes (once per block: skip the empty/full payload variants)
    let timestamp = (node.forkchoiceNode?.extra_data?.timestamp ?? node.forkchoiceNode?.timestamp) as number
    if (timestamp && node.payloadStatus !== 'empty' && node.payloadStatus !== 'full') {
      let receivedAtSlot = timestampToSlot(genesisTime, secondsPerSlot, timestamp) - node.forkchoiceNode.slot
      if(receivedAtSlot >= 1) {
        node.isLate = true;
        lateNodes = [...lateNodes, node]
      }
    }
  })

  // drop childless EMPTY payload nodes that carry (almost) none of their block's weight: noise in the picture.
  // The block's weight is its PENDING node's weight (EMPTY + FULL subtrees); an unrevealed payload
  // leaves EMPTY with 100% of it, so it is always kept.
  if (hideEmptyNodes) {
    const threshold = BigNumber(Number.isFinite(hideEmptyThresholdPercent) ? Math.max(0, hideEmptyThresholdPercent) : 0)
    Object.keys(nodes).forEach(nodeId => {
      const node = nodes[nodeId]
      if (node.isMissingSlot || node.payloadStatus !== 'empty') return
      if (node.childs.length > 0) return
      const parent = nodes[node.parentRoot] as ExistingNetworkNode | undefined
      const blockWeight = parent && !parent.isMissingSlot ? parent.cumulativeToRootWeight : node.cumulativeToRootWeight
      const belowThreshold = node.cumulativeToRootWeight.times(100).lt(blockWeight.times(threshold))
      if (!node.cumulativeToRootWeight.isZero() && !belowThreshold) return
      if (parent && !parent.isMissingSlot) parent.childs = parent.childs.filter(child => child.id !== node.id)
      edges = edges.filter(edge => edge.from !== node.id && edge.to !== node.id)
      delete nodes[nodeId]
      delete roots[nodeId]
    })
  }

  // calculate cumulative weights to head
  Object.keys(roots).forEach(rootId => {
    let root = nodes[rootId] as ExistingNetworkNode
    root.isRoot = true
    root.cumulativeToHeadWeight = root.weight
    heads = [...heads, ...calculateCumulativeToHeadWeights(root)]
  })

  // set final node size
  Object.keys(nodes).forEach(nodeId => {
    let node = nodes[nodeId];
    if (node.isMissingSlot) return
    changeNodeSizeMode(node, nodeSizeMode)
  })

  heads.forEach(head => {
    let node = nodes[head.id] as ExistingNetworkNode
    node.isHead = true
    node.color = validationStatusToColor(head.validationStatus, true)
  })

  return {
    roots: roots,
    heads: heads.sort((a, b) => b.cumulativeToHeadWeight.comparedTo(a.cumulativeToHeadWeight) ?? 0),
    lateNodes: lateNodes,
    networkData: {
      nodes: Object.values(nodes),
      edges: edges
    },
    firstPOSNode: firstPOSNode
  }
}

function App() {
  const [activeErrors, setActiveErrors] = useState<ActiveErrors>({})

  const reportError = useCallback((source: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    setActiveErrors(errors => errors[source] === message ? errors : { ...errors, [source]: message })
  }, [setActiveErrors])

  const clearError = useCallback((source: string) => {
    setActiveErrors(errors => {
      if (!(source in errors)) return errors
      const { [source]: _removed, ...rest } = errors
      return rest
    })
  }, [setActiveErrors])

  const [showSettings, setShowSettings] = useState<boolean>(INITIAL_SHOW_SETTINGS)

  const [forckchoiceDumpArray, setForckchoiceDumpArray] = useState<ForckchoiceDump[]>([])
  const [fetchedForckchoiceDump, setFetchedForckchoiceDump] = useState<any>()
  const [currentForckchoiceDumpIdx, setCurrentForckchoiceDumpIdx] = useState<number>(0)
  const [data, setData] = useState(defaultdata)
  const [heads, setHeads] = useState<NetworkNode[]>([])
  const [lateNodes, setLateNodes] = useState<ExistingNetworkNode[]>([])
  const [roots, setRoots] = useState<any[]>([])
  const [firstPOSNode, setFirstPOSNode] = useState<any | undefined>()
  const [headIdx, setheadIdx] = useState<number>(0)
  const [networkNodes, setNetwortNodes] = useState<any>([])
  const [network, setNetwort] = useState<any>()

  const [poll, setPoll] = useState<boolean>(pollActiveAtStartup)
  const [pollTimer, setPollTimer] = useState<any>(0)
  const [followPoll, setFollowPoll] = React.useState(true)
  const [followCanonicalHead, setFollowCanonicalHead] = React.useState(true)

  const [nodeSizeMode, setNodeSizeMode] = useState<NodeSizeMode>(DEFAULT_NODE_SIZE_MODE)

  // settings
  const [protoArrayEndpoint, setProtoArrayEndpoint] = useState<string>(DEFAULT_ENDPOINT)
  const [pollPeriod, setPollPeriod] = useState<number>(DEFAULT_POLLING_PERIOD)
  const [pollMaxHistory, setPollMaxHistory] = useState<number>(DEFAULT_POLL_MAX_HISTORY)
  const [sourceType, setSourceType] = useState<SourceType>(DEFAULT_SOURCE_TYPE)
  const [drawMissingSlotNodes, setDrawMissingSlotNodes] = useState<boolean>(DEFAULT_DRAW_MISSING_SLOT_NODES)
  const [hideEmptyNodes, setHideEmptyNodes] = useState<boolean>(DEFAULT_HIDE_EMPTY_NODES)
  const [hideEmptyThreshold, setHideEmptyThreshold] = useState<number>(DEFAULT_HIDE_EMPTY_THRESHOLD)
  // Gloas: block and payload nodes share a slot column, so columns get wider to keep big nodes apart
  const [payloadColumns, setPayloadColumns] = useState<boolean>(false)
  const slotWidth = payloadColumns ? SLOT_WIDTH * 2 : SLOT_WIDTH
  const slotHalfWidth = slotWidth / 2
  const [physics, setPhysics] = useState<boolean>(DEFAULT_PHYSICS)
  const [networkType, setNetworkType] = useState<NetworkType>(INITIAL_NETWORK_TYPE)
  const [genesisTime, setGenesisTime] = useState<number>(INITIAL_GENESIS_TIME)
  const [secondsPerSlot, setSecondsPerSlot] = useState<number>(DEFAULT_SECONDS_PER_SLOT)
  const [slotsPerEpoch, setSlotsPerEpoch] = useState<number>(DEFAULT_SLOTS_PER_EPOCH)
  const [ptcSize, setPtcSize] = useState<number>(DEFAULT_PTC_SIZE)
  const [autoDetectStatus, setAutoDetectStatus] = useState<string>('')

  // settings edit
  const [protoArrayEndpointEdit, setProtoArrayEndpointEdit] = useState<string>(DEFAULT_ENDPOINT)
  const [pollPeriodEdit, setPollPeriodEdit] = useState<number>(DEFAULT_POLLING_PERIOD)
  const [pollMaxHistoryEdit, setPollMaxHistoryEdit] = useState<number>(DEFAULT_POLL_MAX_HISTORY)
  const [sourceTypeEdit, setSourceTypeEdit] = useState<SourceType>(DEFAULT_SOURCE_TYPE)
  const [drawMissingSlotNodesEdit, setDrawMissingSlotNodesEdit] = useState<boolean>(DEFAULT_DRAW_MISSING_SLOT_NODES)
  const [hideEmptyNodesEdit, setHideEmptyNodesEdit] = useState<boolean>(DEFAULT_HIDE_EMPTY_NODES)
  const [hideEmptyThresholdEdit, setHideEmptyThresholdEdit] = useState<number>(DEFAULT_HIDE_EMPTY_THRESHOLD)
  const [physicsEdit, setPhysicsEdit] = useState<boolean>(DEFAULT_PHYSICS)
  const [networkTypeEdit, setNetworkTypeEdit] = useState<NetworkType>(INITIAL_NETWORK_TYPE)
  const [genesisTimeEdit, setGenesisTimeEdit] = useState<number>(INITIAL_GENESIS_TIME)
  const [secondsPerSlotEdit, setSecondsPerSlotEdit] = useState<number>(DEFAULT_SECONDS_PER_SLOT)
  const [slotsPerEpochEdit, setSlotsPerEpochEdit] = useState<number>(DEFAULT_SLOTS_PER_EPOCH)
  const [ptcSizeEdit, setPtcSizeEdit] = useState<number>(DEFAULT_PTC_SIZE)

  const inputFile = useRef<any>(null)

  // poll protoarray endpoint
  // remembered per endpoint so a node without v2 is not probed on every poll
  const forkChoiceApiVersion = useRef<ForkChoiceApiVersion>('unknown')
  const [forkChoiceApiVersionLabel, setForkChoiceApiVersionLabel] = useState<ForkChoiceApiVersion>('unknown')
  const [lastFetchAt, setLastFetchAt] = useState<moment.Moment | undefined>()
  useEffect(() => { forkChoiceApiVersion.current = 'unknown'; setForkChoiceApiVersionLabel('unknown'); setLastFetchAt(undefined) }, [protoArrayEndpoint])

  const getProtoArray = useCallback(async () => {
    try {
      const { version, data } = await fetchForkChoice(protoArrayEndpoint, forkChoiceApiVersion.current)
      forkChoiceApiVersion.current = version
      setForkChoiceApiVersionLabel(version)
      setLastFetchAt(moment())
      setFetchedForckchoiceDump(data)
      clearError('fork choice')
    } catch (e) {
      reportError('fork choice', e)
    }
  }, [setFetchedForckchoiceDump, protoArrayEndpoint, reportError, clearError])

  // intervals call through this ref so they always use the latest endpoint and settings,
  // instead of the poll function captured when the timer was created
  const getProtoArrayRef = useRef(getProtoArray)
  useEffect(() => { getProtoArrayRef.current = getProtoArray }, [getProtoArray])
  const pollTick = useCallback(() => { getProtoArrayRef.current() }, [])

  // Auto network: read genesis time and slot duration from the connected node
  const detectNodeParams = useCallback(async () => {
    setAutoDetectStatus('detecting...')
    try {
      const params = await fetchNodeParams(protoArrayEndpoint)
      setGenesisTime(params.genesisTime)
      setGenesisTimeEdit(params.genesisTime)
      setSecondsPerSlot(params.secondsPerSlot)
      setSlotsPerEpoch(params.slotsPerEpoch)
      setPtcSize(params.ptcSize ?? DEFAULT_PTC_SIZE)
      setSecondsPerSlotEdit(params.secondsPerSlot)
      setSlotsPerEpochEdit(params.slotsPerEpoch)
      setPtcSizeEdit(params.ptcSize ?? DEFAULT_PTC_SIZE)
      setAutoDetectStatus(`detected from ${protoArrayEndpoint || 'same origin'}`)
      clearError('node parameters')
    } catch (e) {
      setAutoDetectStatus(`detection failed: ${e instanceof Error ? e.message : e}`)
      reportError('node parameters', e)
    }
  }, [protoArrayEndpoint, setGenesisTime, setGenesisTimeEdit, setSecondsPerSlot, setSlotsPerEpoch, setPtcSize, setSecondsPerSlotEdit, setSlotsPerEpochEdit, setPtcSizeEdit, setAutoDetectStatus, reportError, clearError])

  useEffect(() => {
    if (networkType === NetworkType.auto) detectNodeParams()
  }, [networkType, detectNodeParams])

  // save history
  useEffect(() => {
    if (!fetchedForckchoiceDump) return

    setForckchoiceDumpArray(forchchoiceDumps => {
      while (forchchoiceDumps.length >= pollMaxHistory) {
        forchchoiceDumps.shift()
      }
      return [...forchchoiceDumps, { timestamp: moment(), forkchoiceNodes: fetchedForckchoiceDump.fork_choice_nodes }]
    }
    )
  }, [pollMaxHistory, fetchedForckchoiceDump, setForckchoiceDumpArray])

  // set current index vis, following latest updates
  useEffect(() => {
    if (!forckchoiceDumpArray || forckchoiceDumpArray.length === 0) return
    if (followPoll) {
      setCurrentForckchoiceDumpIdx(forckchoiceDumpArray.length - 1)
    }
  }, [forckchoiceDumpArray, currentForckchoiceDumpIdx, setCurrentForckchoiceDumpIdx, followPoll])

  const handleCanonicalHead = useCallback(() => {
    if (heads.length === 0) return
    // show the head towards the right edge, leaving room for its ancestors on the left, but never
    // push it out of view: the offset is capped to a share of the visible canvas width
    const canvasWidth: number = network?.canvas?.frame?.canvas?.clientWidth ?? 0
    const offsetX = canvasWidth > 0 ? Math.min(slotWidth * 3, canvasWidth * 0.3) : 0
    // a scripted zoom (?zoom=) is applied instantly so screenshots do not catch the animation midway
    const scale = INITIAL_ZOOM !== undefined ? { scale: INITIAL_ZOOM, animation: false } : { animation: true }
    network.moveTo({
      position: network.getPosition(heads[0].id),
      offset: { x: offsetX, y: 0 },
      ...scale
    })
    setheadIdx(0)
  }, [heads, network, setheadIdx, slotWidth])

  // render current data
  useEffect(() => {
    try {
      if (forckchoiceDumpArray.length === 0 || currentForckchoiceDumpIdx >= forckchoiceDumpArray.length) return

      const { firstPOSNode, roots, heads, lateNodes, networkData } = forkchoiceNodesToNetworkData(genesisTime, secondsPerSlot, forckchoiceDumpArray[currentForckchoiceDumpIdx].forkchoiceNodes, sourceType, nodeSizeMode, drawMissingSlotNodes, hideEmptyNodes, hideEmptyThreshold, ptcSize)
      setHeads(heads)
      setLateNodes(lateNodes)
      setRoots(roots)
      setFirstPOSNode(firstPOSNode)
      setData(networkData as any)
      setPayloadColumns(networkData.nodes.some(node => node.level % 2 === 1))
      clearError('data')
    } catch (e) {
      reportError('data', `error loading data - verify source type in settings (${e})`)
    }
  }, [genesisTime,
    secondsPerSlot,
    currentForckchoiceDumpIdx,
    forckchoiceDumpArray,
    sourceType,
    nodeSizeMode,
    drawMissingSlotNodes,
    hideEmptyNodes,
    hideEmptyThreshold,
    ptcSize,
    setData,
    setHeads,
    setLateNodes,
     setRoots, 
     setFirstPOSNode, 
     reportError,
     clearError])

  // poll
  const togglePoll = useCallback((pollIsActive) => {
    setPoll(pollIsActive)
    if (!pollIsActive && pollTimer) {
      clearInterval(pollTimer)
      setPollTimer(0)
      return
    }
    if (pollIsActive && !pollTimer) {
      if (networkType === NetworkType.auto) detectNodeParams()
      getProtoArray()
      let timer = setInterval(pollTick, pollPeriod)

      setPollTimer(timer)
    }
  }, [getProtoArray, pollTick, detectNodeParams, networkType, setPollTimer, setPoll, pollTimer, pollPeriod])

  useEffect(() => {
    if (pollActiveAtStartup) {
      getProtoArray()
      const timer = setInterval(pollTick, DEFAULT_POLLING_PERIOD)
      setPollTimer(timer)
      return () => clearInterval(timer)
    }
  }, [getProtoArray, pollTick])


  useEffect(() => {
    if (followCanonicalHead) {
      const timer = setTimeout(handleCanonicalHead, 200)
      return () => clearTimeout(timer)
    }
  }, [followCanonicalHead, handleCanonicalHead])

  const getNetwork = useCallback((a) => {
    setNetwort(a)
  }, [])

  const getNodes = useCallback((a) => {
    setNetwortNodes(a)
  }, [])

  const handleSlide = useCallback((values) => {
    const value = values[0]
    setCurrentForckchoiceDumpIdx(parseInt(value))
    setFollowPoll(value === forckchoiceDumpArray.length - 1)
  }, [setCurrentForckchoiceDumpIdx, setFollowPoll, forckchoiceDumpArray])


  /*** settings **/

  const handleShowSettings = useCallback(() => {
    setShowSettings(true)
  }, [setShowSettings])


  const handleCloseSettings = useCallback(() => {
    setShowSettings(false)
    const endpoint = normalizeBaseUrl(protoArrayEndpointEdit)
    setProtoArrayEndpointEdit(endpoint)
    setProtoArrayEndpoint(endpoint)
    setPollPeriod(pollPeriodEdit)
    setPollMaxHistory(pollMaxHistoryEdit)
    setSourceType(sourceTypeEdit)
    setSourceType(sourceTypeEdit)
    setDrawMissingSlotNodes(drawMissingSlotNodesEdit)
    setHideEmptyNodes(hideEmptyNodesEdit)
    setHideEmptyThreshold(hideEmptyThresholdEdit)
    setPhysics(physicsEdit)
    setNetworkType(networkTypeEdit)
    if (networkTypeEdit === NetworkType.auto) {
      // the detection effect re-runs when endpoint or network type changed; force it otherwise
      if (endpoint === protoArrayEndpoint && networkType === NetworkType.auto) detectNodeParams()
    } else {
      setGenesisTime(genesisTimeEdit)
      const custom = networkTypeEdit === NetworkType.custom
      const positive = (value: number, fallback: number) => Number.isFinite(value) && value > 0 ? value : fallback
      setSecondsPerSlot(custom ? positive(Number(secondsPerSlotEdit), DEFAULT_SECONDS_PER_SLOT) : DEFAULT_SECONDS_PER_SLOT)
      setSlotsPerEpoch(custom ? positive(Number(slotsPerEpochEdit), DEFAULT_SLOTS_PER_EPOCH) : DEFAULT_SLOTS_PER_EPOCH)
      setPtcSize(custom ? positive(Number(ptcSizeEdit), DEFAULT_PTC_SIZE) : DEFAULT_PTC_SIZE)
      setAutoDetectStatus('')
    }

    if (poll) {
      clearInterval(pollTimer)
      const timer = setInterval(pollTick, pollPeriodEdit)
      setPollTimer(timer)
    }

  }, [setShowSettings,
    pollTick,
    detectNodeParams,
    protoArrayEndpoint,
    networkType,
    sourceTypeEdit,
    pollTimer,
    poll,
    protoArrayEndpointEdit,
    pollPeriodEdit,
    pollMaxHistoryEdit,
    drawMissingSlotNodesEdit,
    hideEmptyNodesEdit,
    hideEmptyThresholdEdit,
    physicsEdit,
    networkTypeEdit,
    genesisTimeEdit,
    secondsPerSlotEdit,
    slotsPerEpochEdit,
    ptcSizeEdit,
    setProtoArrayEndpoint,
    setPollPeriod,
    setPollMaxHistory,
    setSourceType,
    setPhysics,
    setDrawMissingSlotNodes,
    setHideEmptyNodes,
    setHideEmptyThreshold,
    setNetworkType,
    setGenesisTime,
    setSecondsPerSlot,
    setSlotsPerEpoch,
    setPtcSize,
    setAutoDetectStatus,
    setProtoArrayEndpointEdit])

  const handleUpdateEndpoint = useCallback((event) => {
    setProtoArrayEndpointEdit(event.target.value)
  }, [setProtoArrayEndpointEdit])

  const handleSetPollingPeriod = useCallback((event) => {
    setPollPeriodEdit(event.target.value)
  }, [setPollPeriodEdit])

  const handleSetPollMaxHistory = useCallback((event) => {
    setPollMaxHistoryEdit(event.target.value)
  }, [setPollMaxHistoryEdit])

  const handleSourceType = useCallback((type: Option) => {
    setSourceTypeEdit(type.value as SourceType)
  }, [setSourceTypeEdit])

  const handleSetDrawMissingSlotNodes = useCallback((event) => {
    setDrawMissingSlotNodesEdit(event.target.checked)
  }, [setDrawMissingSlotNodesEdit])

  const handleSetHideEmptyNodes = useCallback((event) => {
    setHideEmptyNodesEdit(event.target.checked)
  }, [setHideEmptyNodesEdit])

  const handleSetHideEmptyThreshold = useCallback((event) => {
    setHideEmptyThresholdEdit(Number(event.target.value))
  }, [setHideEmptyThresholdEdit])

  const handleSetPhysics = useCallback((event) => {
    setPhysicsEdit(event.target.checked)
  }, [setPhysicsEdit])

  const handleSetGenesisTime = useCallback((event) => {
    setGenesisTimeEdit(event.target.value)
  }, [setGenesisTimeEdit])

  const handleSetSecondsPerSlot = useCallback((event) => {
    setSecondsPerSlotEdit(Number(event.target.value))
  }, [setSecondsPerSlotEdit])

  const handleSetSlotsPerEpoch = useCallback((event) => {
    setSlotsPerEpochEdit(Number(event.target.value))
  }, [setSlotsPerEpochEdit])

  const handleSetPtcSize = useCallback((event) => {
    setPtcSizeEdit(Number(event.target.value))
  }, [setPtcSizeEdit])

  const handleSetNetworkType = useCallback((type: Option) => {
    let network: NetworkType = type.value as NetworkType

    setNetworkTypeEdit(network)
    switch (network) {
      case NetworkType.mainnet:
        setGenesisTimeEdit(MAINNET_GENESIS_TIME)
        break;
      case NetworkType.goerli:
        setGenesisTimeEdit(GOERLI_GENESIS_TIME)
        break;
      case NetworkType.sepolia:
        setGenesisTimeEdit(SEPOLIA_GENESIS_TIME)
        break;
    }
    if (network !== NetworkType.custom && network !== NetworkType.auto) {
      setSecondsPerSlotEdit(DEFAULT_SECONDS_PER_SLOT)
      setSlotsPerEpochEdit(DEFAULT_SLOTS_PER_EPOCH)
      setPtcSizeEdit(DEFAULT_PTC_SIZE)
    }
  }, [setNetworkTypeEdit, setGenesisTimeEdit, setSecondsPerSlotEdit, setSlotsPerEpochEdit, setPtcSizeEdit])

  /*** head navigation callbacks **/

  const handlePreviousHead = useCallback(() => {
    if (heads.length === 0) return

    const previousHead = (headIdx + 1) % heads.length

    network.fit({
      nodes: [heads[previousHead].id],
      animation: true
    })
    setheadIdx(previousHead)
  }, [network, heads, headIdx, setheadIdx])

  const handleNextHead = useCallback(() => {
    if (heads.length === 0) return

    const nextHead = (Math.max(0, headIdx - 1)) % heads.length

    network.fit({
      nodes: [heads[nextHead].id],
      animation: true
    })
    setheadIdx(nextHead)
  }, [network, heads, headIdx, setheadIdx])

  const handleNodeSizeMode = useCallback((type: Option) => {

    setNodeSizeMode(type.value as NodeSizeMode)
  }, [setNodeSizeMode])

  /*** import export callbacks **/

  const handleExportData = useCallback(() => {
    const jsonString = `data:text/json;chatset=utf-8,${encodeURIComponent(
      JSON.stringify(forckchoiceDumpArray, null, "\t")
    )}`
    const link = document.createElement("a")
    link.href = jsonString
    link.download = "protoarray_dumps.json"

    link.click()
  }, [forckchoiceDumpArray])

  const handleImportData = () => {
    if (!inputFile?.current) return
    inputFile.current.click()
  }

  const parseTekuData = (input: any) => {
    try {
      let data: any[] = typeof input === 'string' ? JSON.parse(input) : input
      if (data[0] !== undefined && data[0].timestamp === undefined) {
        // single protoarray
        return [{ timestamp: moment(), forkchoiceNodes: data } as ForckchoiceDump]
      } else {
        // multiple protoarrays
        for (let dump of data) {
          dump.timestamp = moment(dump.timestamp)
          if (dump.protoArray) {
            dump.forkchoiceNodes = dump.protoArray
            delete dump.protoArray
          }
        }
        return data
      }
    } catch (e) {
      alert("**Not valid Teku JSON file!**\nerror: " + e)
      return []
    }
  }

  const parseNimbusData = (input: any) => {
    const filter = (node: any) => { return node.slot !== FAR_FUTURE_SLOT }
    try {
      let data: any = typeof input === 'string' ? JSON.parse(input) : input
      if (!Array.isArray(data)) {
        // single protoarray
        return [{ timestamp: moment(data.time), forkchoiceNodes: data.protoArray.filter(filter) } as ForckchoiceDump]
      } else {
        // multiple protoarrays
        for (let dump of data) {
          dump.timestamp = moment(dump.time)
          if (dump.protoArray) {
            dump.forkchoiceNodes = dump.protoArray.filter(filter)
            delete dump.protoArray
          }
        }
        return data
      }
    } catch (e) {
      alert("**Not valid Nimbus JSON file!**\nerror: " + e)
      return []
    }
  }

  const parseStandardData = (input: any) => {
    const filter = (node: any) => { return node.slot !== FAR_FUTURE_SLOT }
    try {
      let data: any = typeof input === 'string' ? JSON.parse(input) : input
      if (!Array.isArray(data)) {
        // single protoarray
        return [{
          timestamp: moment(data.time),
          justifiedCheckpoint: data.justified_checkpoint,
          finalizedCheckpoint: data.finalized_checkpoint,
          forkchoiceNodes: data.fork_choice_nodes.filter(filter),
          extraData: data.extra_data
        } as ForckchoiceDump]
      } else {
        // multiple protoarrays
        for (let dump of data) {
          dump.timestamp = moment(dump.time)
          if (dump.protoArray) {
            dump.forkchoiceNodes = dump.fork_choice_nodes.filter(filter)
            dump.justifiedCheckpoint = dump.justified_checkpoint
            dump.finalizedCheckpoint = dump.finalized_checkpoint
            dump.extraData = dump.extra_data
            delete dump.extra_data
            delete dump.justified_checkpoint
            delete dump.finalized_checkpoint
            delete dump.protoArray
          }
        }
        return data
      }
    } catch (e) {
      alert("**Not valid Nimbus JSON file!**\nerror: " + e)
      return []
    }
  }

  const parsePrysmData = (input: any): ForckchoiceDump[] => {
    try {
      let data: any = typeof input === 'string' ? JSON.parse(input) : input
      if (!Array.isArray(data)) {
        // single protoarray
        return [{ timestamp: moment(), forkchoiceNodes: data.forkchoice?.forkchoice_nodes }] as ForckchoiceDump[]
      } else {
        // multiple protoarrays
        for (let sample of data) {
          sample.timestamp = moment()
          if (sample.forkchoice?.forkchoice_nodes) {
            sample.forkchoiceNodes = sample.forkchoice?.forkchoice_nodes
            delete sample.forkchoice.forkchoice_nodes
          }
        }
        return data as ForckchoiceDump[]
      }
    } catch (e) {
      alert("**Not valid Prysm JSON file!**\nerror: " + e)
      return []
    }
  }

  const readFileOnUpload = useCallback((uploadedFile: any) => {
    const fileReader: any = new FileReader()
    fileReader.onloadend = () => {
      let data: any[] | undefined;
      switch (sourceType) {
        case SourceType.teku:
          data = parseTekuData(fileReader.result)
          break;
        case SourceType.prysm:
          data = parsePrysmData(fileReader.result)
          break;
        case SourceType.nimbus:
          data = parseNimbusData(fileReader.result)
          break;
        case SourceType.standard:
          data = parseStandardData(fileReader.result)
      }
      if (data !== undefined) setForckchoiceDumpArray(data)

      inputFile.current.value = null
    }
    if (uploadedFile !== undefined)
      fileReader.readAsText(uploadedFile)
  }, [setForckchoiceDumpArray, inputFile, sourceType])


  // bundled dumps come in a known format: select the matching source type so they render
  const selectSourceType = useCallback((type: SourceType) => {
    setSourceType(type)
    setSourceTypeEdit(type)
  }, [setSourceType, setSourceTypeEdit])

  // legacy Teku (22.12.0 or earlier) dump
  const handleLoadTestData = useCallback(() => {
    let data: any[] | undefined = parseTekuData(testData)
    if (data === undefined) return
    selectSourceType(SourceType.teku)
    setForckchoiceDumpArray(data)
  }, [setForckchoiceDumpArray, selectSourceType])

  // synthetic Gloas v2 dump (see scripts/genGloasTestData.js)
  const handleLoadGloasTestData = useCallback(() => {
    let data: any[] | undefined = parseStandardData(testDataGloas)
    if (data === undefined) return
    selectSourceType(SourceType.standard)
    setForckchoiceDumpArray(data)
  }, [setForckchoiceDumpArray, selectSourceType])

  // the Samples menu is a native <details>: close it on outside click, Escape, or after picking an item
  const samplesMenu = useRef<HTMLDetailsElement>(null)
  const closeSamplesMenu = useCallback(() => { if (samplesMenu.current) samplesMenu.current.open = false }, [])
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (samplesMenu.current?.open && !samplesMenu.current.contains(event.target as Node)) closeSamplesMenu()
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') closeSamplesMenu() }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [closeSamplesMenu])

  // ?sample=gloas|teku: load a bundled dump once on start (the network parameter is applied as initial state above)
  const sampleParamHandled = useRef(false)
  useEffect(() => {
    if (sampleParamHandled.current) return
    sampleParamHandled.current = true
    const sample = new URLSearchParams(window.location.search).get('sample')
    if (sample === 'gloas') handleLoadGloasTestData()
    else if (sample === 'teku') handleLoadTestData()
  }, [handleLoadGloasTestData, handleLoadTestData])

  const events = useMemo(() => {
    return {
      click: function (params) {
        if (params.nodes.length === 0) return
        let node: NetworkNode = networkNodes.get(params.nodes[0])
        if (!node || node.isMissingSlot) return
        let blockRoot: string = node.forkchoiceNode.blockRoot
        if (navigator.clipboard === undefined) {
          alert('clipboard not available in unsecure context')
        } else {
          navigator.clipboard.writeText(blockRoot)
        }

        console.log({
          value: node.value,
          weight: node.weight.toFixed(),
          cumulativeToHeadWeight: node.cumulativeToHeadWeight.toFixed(),
          cumulativeToRootWeight: node.cumulativeToRootWeight.toFixed()
        })

        params.event = "[original event]"
      },
      doubleClick: function (params) {
        if (params.nodes.length === 0) return
        let node: any = networkNodes.get(params.nodes[0])
        if (!node) return
        let json: string = JSON.stringify(node.protoNode, null, ' ')
        if (navigator.clipboard === undefined) {
          alert('clipboard not available in unsecure context')
        } else {
          navigator.clipboard.writeText(json)
        }
        params.event = "[original event]"
      },
      showPopup: function (params) {
        let popup: HTMLElement | null = document.getElementById('jsonNodeInfo')
        if (popup && popup.childElementCount === 0) {
          hljs.highlightElement(popup as HTMLElement)
        }
      },
      beforeDrawing: function (ctx) {
        if (network === undefined || networkNodes === undefined || networkNodes.length === 0) return

        const scale = network.getScale()
        const translate = network.getViewPosition()

        // find a leftmost (ancestor) node and min\max slot
        let leftMostNode: any
        let minSlot: number = 0
        let maxSlot: number = 0

        Object.keys(roots).forEach(rootId => {
          let node = roots[rootId]
          if (!leftMostNode || node.slot < minSlot) {
            minSlot = node.slot
            leftMostNode = node
          }
        })

        heads.forEach(head => {
          if (head.slot > maxSlot) maxSlot = head.slot
        })

        const minEpoch: number = Math.floor(minSlot / slotsPerEpoch)
        const maxEpoch: number = Math.floor(maxSlot / slotsPerEpoch)
        const leftMostNodeSlot: number = minSlot
        minSlot = minEpoch * slotsPerEpoch
        maxSlot = maxEpoch * slotsPerEpoch + slotsPerEpoch - 1

        const leftMostPosition = network.getPosition(leftMostNode.id)
        // with Gloas payload nodes present, block nodes sit on the left half of their slot column
        const blockOffset = payloadColumns ? slotWidth / 4 : 0

        const clientHalfHeightOffset = (ctx.canvas.clientHeight / 2) / scale
        const clientHeightOffset = ctx.canvas.clientHeight / scale

        const absoluteTop = translate.y - clientHalfHeightOffset
        const absoluteBottom = translate.y + clientHalfHeightOffset

        // epoch grid
        const colorA = "#FFFFFF"
        const colorB = "#CCFFFF"
        const minEpochStartOffset = leftMostPosition.x + blockOffset - slotHalfWidth + ((minSlot - leftMostNodeSlot) * slotWidth)
        const epochWidth = slotsPerEpoch * slotWidth

        let beginEpochPos = minEpochStartOffset
        ctx.font = "30px Georgia"
        for (let epoch: number = minEpoch; epoch <= maxEpoch; epoch++) {
          ctx.fillStyle = epoch % 2 === 0 ? colorA : colorB
          ctx.fillRect(beginEpochPos, absoluteTop, epochWidth, clientHeightOffset)
          ctx.fillStyle = "#000000"
          const epochLeft = beginEpochPos + epochWidth * 0.33
          const epochRight = beginEpochPos + epochWidth * 0.66
          const textWidth = ctx.measureText(epoch).width / 2
          ctx.fillText(epoch, epochLeft - textWidth, absoluteTop + 30)
          ctx.fillText(epoch, epochRight - textWidth, absoluteTop + 30)
          beginEpochPos = beginEpochPos + epochWidth
        }

        // slot grid
        ctx.font = "20px Georgia"
        for (let slot: number = minSlot; slot <= maxSlot; slot++) {
          const slotLabel = slot + " (" + slot % slotsPerEpoch + ")"
          let slotDiff: number = slot - leftMostNodeSlot
          ctx.beginPath()
          let slotCenter = slotDiff * slotWidth + leftMostPosition.x + blockOffset
          ctx.moveTo(slotCenter + slotHalfWidth, absoluteTop + 50)
          ctx.lineTo(slotCenter + slotHalfWidth, absoluteBottom)
          ctx.stroke()
          ctx.fillStyle = "#000000"
          ctx.fillText(slotLabel, slotCenter - ctx.measureText(slotLabel).width / 2, absoluteTop + 60)
        }

        // terminal node
        if (firstPOSNode) {
          const posLabel = '🐼 MERGE 🐼'
          const posNodePosition = network.getPosition(firstPOSNode.id)
          let x = posNodePosition.x - ctx.measureText(posLabel).width / 2
          ctx.fillText(posLabel, x, posNodePosition.y - 100)
        }

        // late nodes
        
        lateNodes.forEach(node => {
          ctx.lineJoin = "round"
          ctx.lineCap = "round"
          ctx.lineWidth = 2
          ctx.strokeStyle = "#ebe244";

          let nodePosition = network.getPosition(node.id)
          ctx.beginPath()
          ctx.moveTo(nodePosition.x, nodePosition.y)
          let actualTimestamp = node.forkchoiceNode.extra_data.timestamp
          let lateBySlot = timestampToSlot(genesisTime, secondsPerSlot, actualTimestamp) - node.forkchoiceNode.slot
          let expectedTimestamp = slotToTimestamp(genesisTime, secondsPerSlot, node.forkchoiceNode.slot)
          let newy = nodePosition.y + 100
          ctx.lineTo(nodePosition.x, newy)
          let newx = nodePosition.x + blockOffset + (lateBySlot * slotWidth) - slotHalfWidth
          ctx.lineTo(newx, newy)
          ctx.moveTo(newx, newy - 10)
          ctx.lineTo(newx, newy + 10)
          ctx.stroke()
          ctx.strokeStyle = "#cfa044";
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(newx, newy - 8)
          ctx.lineTo(newx, newy + 8)
          ctx.stroke()

          ctx.fillStyle = "#cfa044"
          let lateDuration = moment.duration(actualTimestamp - expectedTimestamp, 'seconds')
          let label = `${lateDuration.minutes()}m:${lateDuration.seconds()}s`
          ctx.fillText(label, newx+3, newy + 5)
        });
      },

      afterDrawing: function (ctx) {
        if (network === undefined || networkNodes === undefined || networkNodes.length === 0) return

        heads.forEach((head, idx) => {
          let nodePositions = network.getPositions(head.id)
          let position = nodePositions[head.id]
          if (!position || isNaN(position.x)) return
          if (idx !== -1) {
            ctx.shadowColor = "black"
            ctx.shadowBlur = 5
            ctx.fillStyle = "white"
            let headLabel = idx + 1
            let measure = ctx.measureText(headLabel)
            let x = position.x - measure.width / 2

            let y = position.y - (measure.actualBoundingBoxDescent - measure.actualBoundingBoxAscent) / 2
            ctx.strokeText(headLabel, x, y)
            ctx.fillText(headLabel, x, y)
          }
        })
      },
    }
  }, [network, genesisTime, secondsPerSlot, slotsPerEpoch, networkNodes, heads, lateNodes, roots, firstPOSNode, payloadColumns, slotWidth, slotHalfWidth])

  const forkChoiceError = activeErrors['fork choice']
  const connectionState: 'connected' | 'error' | 'idle' = forkChoiceError ? 'error' : (lastFetchAt ? 'connected' : 'idle')
  const connectionTooltip = [
    `endpoint: ${protoArrayEndpoint || 'same origin (proxied)'}`,
    `fork choice API: ${forkChoiceApiVersionLabel === 'unknown' ? 'not probed yet' : `/eth/${forkChoiceApiVersionLabel}/debug/fork_choice`}`,
    `last fetch: ${lastFetchAt ? lastFetchAt.local().format('YYYY-MM-DD HH:mm:ss') : 'never'}`,
    `polling: ${poll ? `every ${pollPeriod / 1000}s` : 'off'}`,
    `network: ${networkType}`,
    `genesis: ${moment(genesisTime * 1000).local().format('YYYY-MM-DD HH:mm:ss Z')}`,
    `slot: ${secondsPerSlot}s · ${slotsPerEpoch} slots/epoch · PTC size: ${ptcSize}`,
    ...(forkChoiceError ? [`error: ${forkChoiceError}`] : []),
  ].join('\n')

  return (
    <>
      {payloadColumns && !showSettings && <PtcLegend ptcSize={ptcSize} />}
        <div className="App">
          <Modal
            isOpen={showSettings}
            contentLabel="Settings"
            ariaHideApp={false}
            className="settings-dialog"
            overlayClassName="settings-overlay"
            onRequestClose={handleCloseSettings}
          >
            <div className="settings-header">
              <h2>Settings</h2>
              <button className="tb-btn settings-close" onClick={handleCloseSettings} title="apply and close">Done</button>
            </div>

            <section className="settings-section">
              <h3>Connection</h3>
              <div className="settings-row">
                <label className="settings-label" htmlFor="s-url">Beacon node URL</label>
                <div className="settings-control">
                  <input id="s-url" className="settings-input settings-input-wide" type="text" value={protoArrayEndpointEdit} onChange={handleUpdateEndpoint} placeholder="http://localhost:5051" />
                  <div className="settings-hint">Base URL of a standard Beacon API. Fork choice is read from /eth/v2/debug/fork_choice, falling back to v1. Leave empty when served through the bundled proxy.</div>
                </div>
              </div>
              <div className="settings-row">
                <label className="settings-label" htmlFor="s-refresh">Refresh</label>
                <div className="settings-control settings-inline">
                  <input id="s-refresh" className="settings-input settings-input-num" type="number" min="500" step="500" value={pollPeriodEdit} onChange={handleSetPollingPeriod} />
                  <span className="settings-unit">ms</span>
                  <label className="settings-label settings-label-inline" htmlFor="s-history">Max history</label>
                  <input id="s-history" className="settings-input settings-input-num" type="number" min="1" value={pollMaxHistoryEdit} onChange={handleSetPollMaxHistory} />
                  <span className="settings-unit">snapshots</span>
                </div>
              </div>
              <div className="settings-row">
                <label className="settings-label" htmlFor="s-source">Source type</label>
                <div className="settings-control">
                  <select id="s-source" className="settings-input" value={sourceTypeEdit} onChange={(event) => handleSourceType({ value: event.target.value, label: event.target.value })}>
                    {Object.values(SourceType).map(type => <option key={type} value={type}>{type}</option>)}
                  </select>
                  <div className="settings-hint">Standard covers current nodes (v1 and Gloas v2). The others parse legacy client-specific dumps.</div>
                </div>
              </div>
            </section>

            <section className="settings-section">
              <h3>Network</h3>
              <div className="settings-row">
                <label className="settings-label" htmlFor="s-network">Network</label>
                <div className="settings-control">
                  <select id="s-network" className="settings-input" value={networkTypeEdit} onChange={(event) => handleSetNetworkType({ value: event.target.value, label: event.target.value })}>
                    {Object.values(NetworkType).map(type => <option key={type} value={type}>{type}</option>)}
                  </select>
                  {networkTypeEdit === NetworkType.auto &&
                    <div className="settings-hint">
                      Genesis time, slot duration, slots per epoch and PTC size are read from the node whenever settings are applied or polling starts.
                      {autoDetectStatus && <span className={autoDetectStatus.startsWith('detection failed') ? 'settings-status settings-status-bad' : 'settings-status'}> {autoDetectStatus}</span>}
                    </div>}
                </div>
              </div>
              <div className="settings-row">
                <label className="settings-label" htmlFor="s-genesis">Genesis time</label>
                <div className="settings-control settings-inline">
                  <input id="s-genesis" className="settings-input settings-input-num settings-input-epoch" disabled={networkTypeEdit !== NetworkType.custom} type="number" value={genesisTimeEdit} onChange={handleSetGenesisTime} />
                  <span className="settings-unit">{moment(genesisTimeEdit * 1000).local().format('YYYY-MM-DD HH:mm:ss Z')}</span>
                </div>
              </div>
              <div className="settings-row">
                <label className="settings-label" htmlFor="s-spslot">Slot</label>
                <div className="settings-control settings-inline">
                  <input id="s-spslot" className="settings-input settings-input-num settings-input-small" disabled={networkTypeEdit !== NetworkType.custom} type="number" min="1" value={networkTypeEdit === NetworkType.custom ? secondsPerSlotEdit : secondsPerSlot} onChange={handleSetSecondsPerSlot} />
                  <span className="settings-unit">s per slot</span>
                  <input id="s-spepoch" className="settings-input settings-input-num settings-input-small" disabled={networkTypeEdit !== NetworkType.custom} type="number" min="1" value={networkTypeEdit === NetworkType.custom ? slotsPerEpochEdit : slotsPerEpoch} onChange={handleSetSlotsPerEpoch} />
                  <span className="settings-unit">per epoch</span>
                  <span className="settings-label settings-label-inline">PTC size</span>
                  <input id="s-ptc" className="settings-input settings-input-num settings-input-small" disabled={networkTypeEdit !== NetworkType.custom} type="number" min="1" value={networkTypeEdit === NetworkType.custom ? ptcSizeEdit : ptcSize} onChange={handleSetPtcSize} />
                </div>
              </div>
            </section>

            <section className="settings-section">
              <h3>Display</h3>
              <div className="settings-row">
                <label className="switch settings-switch">
                  <input type="checkbox" checked={drawMissingSlotNodesEdit} onChange={handleSetDrawMissingSlotNodes} />
                  <span className="switch-track" />
                  Draw missing slot nodes
                  <span className="settings-hint-inline">improves fork visualization</span>
                </label>
              </div>
              <div className="settings-row">
                <label className="switch settings-switch">
                  <input type="checkbox" checked={hideEmptyNodesEdit} onChange={handleSetHideEmptyNodes} />
                  <span className="switch-track" />
                  Hide childless EMPTY payload nodes below
                  <input disabled={!hideEmptyNodesEdit} className="settings-input settings-input-num settings-input-small" type="number" min="0" max="100" step="0.1" value={hideEmptyThresholdEdit} onChange={handleSetHideEmptyThreshold} onClick={(event) => event.preventDefault()} />
                  % of block weight
                </label>
              </div>
              <div className="settings-row">
                <label className="switch settings-switch">
                  <input type="checkbox" checked={physicsEdit} onChange={handleSetPhysics} />
                  <span className="switch-track" />
                  Physics
                  <span className="settings-hint-inline">let nodes settle within their slot column</span>
                </label>
              </div>
            </section>
          </Modal>
          <div className="main">
            <div className="header toolbar">
              <div className="tb-region tb-left">
                <div className="tb-group">
                  <button className="tb-btn" onClick={handleShowSettings} title="settings">⚙ Settings</button>
                  <button className="tb-btn" onClick={handleImportData} title="import a fork choice dump">⇧ Import</button>
                  <button className="tb-btn" onClick={handleExportData} title="export the current history">⇩ Export</button>
                  <details className="tb-menu" ref={samplesMenu}>
                    <summary className="tb-btn" title="bundled sample data">⚗ Samples ▾</summary>
                    <div className="tb-menu-items">
                      <button className="tb-btn" onClick={() => { closeSamplesMenu(); handleLoadTestData() }} title="legacy Teku dump; switches source type to Teku">Legacy Teku dump</button>
                      <button className="tb-btn" onClick={() => { closeSamplesMenu(); handleLoadGloasTestData() }} title="synthetic Gloas v2 dump; switches source type to Standard">Synthetic Gloas dump</button>
                    </div>
                  </details>
                </div>
                <div className="tb-group">
                  <button className={poll ? 'tb-btn active' : 'tb-btn'} onClick={() => togglePoll(!poll)} title={poll ? 'stop polling the node' : 'start polling the node'}>{poll ? '■ Stop' : '▶ Poll'}</button>
                  {poll && <span className="tb-live">● live · {pollPeriod / 1000}s</span>}
                  <label className="switch tb-switch" title="jump to the latest snapshot as new data arrives">
                    <input type="checkbox" checked={followPoll} onChange={(event) => setFollowPoll(event.target.checked)} />
                    <span className="switch-track" />
                    follow
                  </label>
                </div>
              </div>
              <div className="tb-region tb-center">
                <div className="tb-group">
                  <span className="tb-text">Heads <span className="tb-badge">{heads.length}</span></span>
                  <button className="tb-btn" onClick={handleNextHead} title="previous head (heavier)">‹</button>
                  <span className="tb-text tb-mono" title="selected head: position by weight, and its slot">
                    {heads.length > 0 ? `${headIdx + 1} / ${heads.length} · slot ${heads[headIdx]?.slot ?? heads[0].slot}` : '0 / 0'}
                  </span>
                  <button className="tb-btn" onClick={handlePreviousHead} title="next head (lighter)">›</button>
                  <button className="tb-btn" onClick={handleCanonicalHead} title="center the view on the canonical head">⌖ Center</button>
                  <label className="switch tb-switch" title="re-center the view on the canonical head after each update">
                    <input type="checkbox" checked={followCanonicalHead} onChange={(event) => setFollowCanonicalHead(event.target.checked)} />
                    <span className="switch-track" />
                    auto
                  </label>
                </div>
              </div>
              <div className="tb-region tb-right">
                <div className="tb-group">
                  <span className="tb-text">Size</span>
                  <select className="tb-select" value={nodeSizeMode} onChange={(event) => handleNodeSizeMode({ value: event.target.value, label: event.target.value })} title="what a node's size represents">
                    {Object.values(NodeSizeMode).map(mode => <option key={mode} value={mode}>{mode}</option>)}
                  </select>
                </div>
                {heads.length > 0 && <span className="tb-chip" title="epoch of the canonical head">epoch {Math.floor(heads[0].slot / slotsPerEpoch)}</span>}
                <span className={`tb-chip tb-conn ${connectionState}`} title={connectionTooltip}>
                  {connectionState === 'connected' && `● connected · ${forkChoiceApiVersionLabel}`}
                  {connectionState === 'error' && '● node error'}
                  {connectionState === 'idle' && '○ not connected'}
                </span>
              </div>

              <input type='file' id='file' onChange={(e: any) => readFileOnUpload(e.target.files[0])} ref={inputFile} style={{ display: 'none' }} />
            </div>
            <ErrorPanel errors={activeErrors} />
            <div className="network">
              <VisNetworkReactComponent
                data={data}
                options={{
                  height: '100%',
                  layout: {
                    randomSeed: 2,
                    hierarchical: {
                      enabled: true,
                      direction: 'LR',
                      sortMethod: 'directed',
                      ...(physics ? {} : { nodeSpacing: slotWidth }),
                      levelSeparation: slotWidth / 2
                    }
                  },
                  edges: { arrows: 'to' },
                  nodes: {
                    fixed: {
                      x: true
                    },
                    shape: 'dot',
                    scaling: { min: 15, max: 50 }
                  },
                  physics: {
                    enabled: physics,

                    //hierarchicalRepulsion: {
                    //   nodeDistance: 200,
                    // },
                  },
                  interaction: {
                    navigationButtons: true,
                    keyboard: true,
                    dragNodes: true
                  },
                }}
                events={events}
                getNodes={getNodes}
                getNetwork={getNetwork}
              />
            </div>
            <div className="footer">
              <div className="timeline">
                <span className="timeline-time" title={forckchoiceDumpArray.length > 0 ? `oldest snapshot: ${forckchoiceDumpArray[0].timestamp.local().format('YYYY-MM-DD HH:mm:ss Z')}` : 'no snapshots yet'}>{forckchoiceDumpArray.length > 0 ? forckchoiceDumpArray[0].timestamp.local().format('HH:mm:ss') : '--:--:--'}</span>
                <div className="timeline-slider">
                  <Range renderTrack={({ props, children }) => (
                    <div
                      onMouseDown={props.onMouseDown}
                      onTouchStart={props.onTouchStart}
                      className="timeline-track-area"
                      style={props.style}
                    >
                      <div
                        ref={props.ref}
                        className="timeline-track"
                        style={{
                          background: getTrackBackground({
                            values: [currentForckchoiceDumpIdx],
                            colors: ['#3fb950', '#4a4a4a'],
                            min: 0,
                            max: Math.max(1, forckchoiceDumpArray.length - 1)
                          })
                        }}
                      >
                        {children}
                      </div>
                    </div>
                  )}
                    renderThumb={({ props, isDragged }) => (
                      <div {...props} className={isDragged ? 'timeline-thumb dragged' : 'timeline-thumb'} style={props.style}>
                        {forckchoiceDumpArray.length > 0 &&
                          <div className="timeline-tip" title={forckchoiceDumpArray[currentForckchoiceDumpIdx]?.timestamp.local().format('YYYY-MM-DD HH:mm:ss Z')}>
                            {forckchoiceDumpArray[currentForckchoiceDumpIdx]?.timestamp.local().format('HH:mm:ss')}
                            <span className="timeline-tip-idx">{currentForckchoiceDumpIdx + 1}/{forckchoiceDumpArray.length}</span>
                          </div>}
                      </div>
                    )}
                    renderMark={({ props, index }) => (
                      <div {...props} className={index < currentForckchoiceDumpIdx ? 'timeline-mark passed' : 'timeline-mark'} style={props.style} />
                    )}
                    min={0} max={Math.max(1, forckchoiceDumpArray.length - 1)}
                    step={1}
                    values={[currentForckchoiceDumpIdx]}
                    onChange={handleSlide} />
                </div>
                <span className="timeline-time" title={forckchoiceDumpArray.length > 0 ? `latest snapshot: ${forckchoiceDumpArray[forckchoiceDumpArray.length - 1].timestamp.local().format('YYYY-MM-DD HH:mm:ss Z')}` : 'no snapshots yet'}>{forckchoiceDumpArray.length > 0 ? forckchoiceDumpArray[forckchoiceDumpArray.length - 1].timestamp.local().format('HH:mm:ss') : '--:--:--'}</span>
              </div>
            </div>
          </div>
        </div>
    </>
  )
}

export default App
