import React, { useCallback, useState, useEffect, useMemo, useRef } from "react"
import './App.css'
import moment from 'moment'

import BigNumber from "bignumber.js"
import VisNetworkReactComponent from "vis-network-react"
import { Range, getTrackBackground } from 'react-range'
import Modal from 'react-modal'

import Dropdown, { Option } from 'react-dropdown';
import 'react-dropdown/style.css';

import hljs from 'highlight.js'
import 'highlight.js/styles/default.css'
import 'vis-network/styles/vis-network.min.css'

import testData from './testData.json'

const SLOT_WIDTH: number = 150
const SLOT_HALF_WIDTH: number = SLOT_WIDTH / 2
const SLOT_PER_EPOCH: number = 32

const DEFAULT_POLLING_PERIOD: number = 6000
const DEFAULT_ENDPOINT: string = 'http://localhost:5051/teku/v1/debug/beacon/protoarray'
const DEFAULT_POLL_MAX_HISTORY: number = 50

const pollActiveAtStartup: boolean = false

enum SourceType {
  teku = 'Teku',
  prysm = 'Prysm'
}

enum NodeSizeMode {
  nodeOnlyWeight = 'node only weight',
  rootToHeadsCumulated = 'root->heads cumulation',
  HeadsToRootCumulated = 'heads->root cumulation'
}

type ValidationStatus = 'INVALID' | 'OPTIMISTIC' | 'VALID'

type NetworkNode = {
  id: string
  title: HTMLDivElement
  label: string
  level: number
  value: number
  color: string
  forkchoiceNode: any
  isMerge: boolean
  isFirstPOS: boolean
  parentRoot: string
  isRoot: boolean
  isHead: boolean
  weight: BigNumber
  validationStatus: ValidationStatus
  cumulativeToRootWeight: BigNumber
  cumulativeToHeadWeight: BigNumber
  childs: NetworkNode[]
}

type IdToNetworkNode = {
  [id: string]: NetworkNode;
};


const DEFAULT_NODE_SIZE_MODE: NodeSizeMode = NodeSizeMode.nodeOnlyWeight
const DEFAULT_SOURCE_TYPE: SourceType = SourceType.teku

type ForckchoiceDump = {
  timestamp: moment.Moment
  protoArray: any
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
    level: parseInt(forkchoiceNode.slot),
    value: 0,
    color: validationStatusToColor(forkchoiceNode.validationStatus, false),
    forkchoiceNode: forkchoiceNode,
    isMerge: isMerge,
    isFirstPOS: false,
    parentRoot: forkchoiceNode.parentRoot,
    isRoot: false,
    isHead: false,
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
    level: parseInt(forkchoiceNode.slot),
    value: 0,
    color: validationStatusToColor(validationStatus, false),
    forkchoiceNode: forkchoiceNode,
    isMerge: isMerge,
    isFirstPOS: false,
    parentRoot: forkchoiceNode.parent_root,
    isRoot: false,
    isHead: false,
    validationStatus: validationStatus,
    cumulativeToRootWeight: cumulativeToRootWeight,
    cumulativeToHeadWeight: BigNumber(0),
    weight: BigNumber(0),
    childs: []
  }
}


function changeNodeSizeMode(node: NetworkNode, mode: NodeSizeMode) {

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


function calculateCumulativeToHeadWeights(root: NetworkNode): NetworkNode[] {
  if (root.childs.length === 0) {
    return [root]
  } else {
    let heads: NetworkNode[] = []
    root.childs.forEach(child => {
      child.cumulativeToHeadWeight = root.cumulativeToHeadWeight.plus(child.weight)
      heads = [...heads, ...calculateCumulativeToHeadWeights(child)]
    })
    return heads
  }
}

function forkchoiceDumpNodesToNetworkData(forckchoiceNodes, sourceType: SourceType, nodeSizeMode: NodeSizeMode) {
  let nodes: IdToNetworkNode = {}
  let edges: any = []
  let heads: NetworkNode[] = []
  let headsIds: any = []
  let roots: any = {}
  let firstPOSNode: any

  forckchoiceNodes.forEach(forckchoiceNode => {
    switch (sourceType) {
      case SourceType.teku:
        nodes[forckchoiceNode.blockRoot] = forkchoiceNodeToNetworkNode_Teku(forckchoiceNode)
        edges.push({ from: forckchoiceNode.blockRoot, to: forckchoiceNode.parentRoot })
        headsIds.push(forckchoiceNode.blockRoot)
        break;
      case SourceType.prysm:
        nodes[forckchoiceNode.root] = forkchoiceNodeToNetworkNode_Prysm(forckchoiceNode)
        edges.push({ from: forckchoiceNode.root, to: forckchoiceNode.parent_root })
        headsIds.push(forckchoiceNode.root)
    }

  })

  // first pass: set additional flags and find roots 
  Object.keys(nodes).forEach(nodeId => {
    let node = nodes[nodeId];
    delete headsIds[node.parentRoot]

    let parent: any = nodes[node.parentRoot]
    if (parent === undefined) {
      roots[node.id] = nodes[node.id]
    } else {
      parent.childs.push(node)
    }

    if (parent === undefined) {
      node.isFirstPOS = false
      return
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
    let node = nodes[nodeId];
    node.weight = node.cumulativeToRootWeight;
    node.childs.forEach(child => {
      node.weight = node.weight.minus(child.cumulativeToRootWeight);
    })
  })

  // calculate cumulative weights to head
  Object.keys(roots).forEach(rootId => {
    let root = nodes[rootId]
    root.isRoot = true
    root.cumulativeToHeadWeight = root.weight
    heads = [...heads, ...calculateCumulativeToHeadWeights(root)]
  })

  // set final node size
  Object.keys(nodes).forEach(nodeId => {
    changeNodeSizeMode(nodes[nodeId], nodeSizeMode)
  })

  heads.forEach(head => {
    nodes[head.id].isHead = true
    nodes[head.id].color = validationStatusToColor(head.validationStatus, true)
  })

  return {
    roots: roots,
    heads: heads.sort((a, b) => b.cumulativeToHeadWeight.comparedTo(a.cumulativeToHeadWeight)),
    networkData: {
      nodes: Object.values(nodes),
      edges: edges
    },
    firstPOSNode: firstPOSNode
  }
}

function App() {
  const [showSettings, setShowSettings] = useState<boolean>(false)

  const [forckchoiceDumpArray, setForckchoiceDumpArray] = useState<ForckchoiceDump[]>([])
  const [fetchedForckchoiceDump, setFetchedForckchoiceDump] = useState<any>()
  const [currentForckchoiceDumpIdx, setCurrentForckchoiceDumpIdx] = useState<number>(0)
  const [data, setData] = useState(defaultdata)
  const [heads, setHeads] = useState<any[]>([])
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

  // settings edit
  const [protoArrayEndpointEdit, setProtoArrayEndpointEdit] = useState<string>(DEFAULT_ENDPOINT)
  const [pollPeriodEdit, setPollPeriodEdit] = useState<number>(DEFAULT_POLLING_PERIOD)
  const [pollMaxHistoryEdit, setPollMaxHistoryEdit] = useState<number>(DEFAULT_POLL_MAX_HISTORY)
  const [sourceTypeEdit, setSourceTypeEdit] = useState<SourceType>(DEFAULT_SOURCE_TYPE)

  const inputFile = useRef<any>(null)

  // poll protoarray endpoint
  const getProtoArray = useCallback(async () => {
    const res = await fetch(protoArrayEndpoint)
    const data = await res.json()
    setFetchedForckchoiceDump(data)
  }, [setFetchedForckchoiceDump, protoArrayEndpoint])

  // save history
  useEffect(() => {
    if (!fetchedForckchoiceDump) return

    setForckchoiceDumpArray(protoArraySamples => {
      while (protoArraySamples.length >= pollMaxHistory) {
        protoArraySamples.shift()
      }
      return [...protoArraySamples, { timestamp: moment(), protoArray: fetchedForckchoiceDump }]
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
    network.fit({
      nodes: [heads[0].id],
      animation: true
    })
    setheadIdx(0)
  }, [heads, network, setheadIdx])

  // render current data
  useEffect(() => {
    if (forckchoiceDumpArray.length === 0 || currentForckchoiceDumpIdx >= forckchoiceDumpArray.length) return
    const { firstPOSNode, roots, heads, networkData } = forkchoiceDumpNodesToNetworkData(forckchoiceDumpArray[currentForckchoiceDumpIdx].protoArray, sourceType, nodeSizeMode)
    setHeads(heads)
    setRoots(roots)
    setFirstPOSNode(firstPOSNode)
    setData(networkData as any)
  }, [currentForckchoiceDumpIdx, forckchoiceDumpArray, sourceType, setData, setHeads, setRoots, setFirstPOSNode, nodeSizeMode])

  // poll
  const togglePoll = useCallback((pollIsActive) => {
    setPoll(pollIsActive)
    if (!pollIsActive && pollTimer) {
      clearInterval(pollTimer)
      setPollTimer(0)
      return
    }
    if (pollIsActive && !pollTimer) {
      getProtoArray()
      let timer = setInterval(getProtoArray, pollPeriod)

      setPollTimer(timer)
    }
  }, [getProtoArray, setPollTimer, setPoll, pollTimer, pollPeriod])

  useEffect(() => {
    if (pollActiveAtStartup) {
      getProtoArray()
      const timer = setInterval(getProtoArray, DEFAULT_POLLING_PERIOD)
      setPollTimer(timer)
      return () => clearInterval(timer)
    }
  }, [getProtoArray])


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
    setProtoArrayEndpoint(protoArrayEndpointEdit)
    setPollPeriod(pollPeriodEdit)
    setPollMaxHistory(pollMaxHistoryEdit)
    setSourceType(sourceTypeEdit)

    if (poll) {
      clearInterval(pollTimer)
      const timer = setInterval(getProtoArray, pollPeriodEdit)
      setPollTimer(timer)
    }

  }, [setShowSettings,
    getProtoArray,
    sourceTypeEdit,
    pollTimer,
    poll,
    protoArrayEndpointEdit,
    pollPeriodEdit,
    pollMaxHistoryEdit,
    setProtoArrayEndpoint,
    setPollPeriod,
    setPollMaxHistory,
    setSourceType])

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
        return [{ timestamp: moment(), protoArray: data } as ForckchoiceDump]
      } else {
        // multiple protoarrays
        for (let sample of data) {
          sample.timestamp = moment(sample.timestamp)
        }
        return data
      }
    } catch (e) {
      alert("**Not valid JSON file!**")
    }
  }

  const parsePrysmData = (input: any) => {
    try {
      let data: any = typeof input === 'string' ? JSON.parse(input) : input
      if (!Array.isArray(data)) {
        // single protoarray
        return [{ timestamp: moment(), protoArray: data.forkchoice_nodes } as ForckchoiceDump]
      } else {
        // multiple protoarrays
        for (let sample of data) {
          sample.timestamp = moment(sample.timestamp)
        }
        return data
      }
    } catch (e) {
      alert("**Not valid JSON file!**")
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
      }
      if (data !== undefined) setForckchoiceDumpArray(data)

      inputFile.current.value = null
    }
    if (uploadedFile !== undefined)
      fileReader.readAsText(uploadedFile)
  }, [setForckchoiceDumpArray, inputFile, sourceType])


  const handleLoadTestData = useCallback(() => {
    let data: any[] | undefined = parseTekuData(testData)
    if (data !== undefined) setForckchoiceDumpArray(data)
  }, [setForckchoiceDumpArray])

  const events = useMemo(() => {
    return {
      click: function (params) {
        if (params.nodes.length === 0) return
        let node: NetworkNode = networkNodes.get(params.nodes[0])
        if (!node) return
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
          if (!leftMostNode || node.level < minSlot) {
            minSlot = node.level
            leftMostNode = node
          }
        })

        heads.forEach(head => {
          if (head.level > maxSlot) maxSlot = head.level
        })

        const minEpoch: number = Math.floor(minSlot / SLOT_PER_EPOCH)
        const maxEpoch: number = Math.floor(maxSlot / SLOT_PER_EPOCH)
        const leftMostNodeSlot: number = minSlot
        minSlot = minEpoch * SLOT_PER_EPOCH
        maxSlot = maxEpoch * SLOT_PER_EPOCH + SLOT_PER_EPOCH - 1

        const leftMostPosition = network.getPosition(leftMostNode.id)

        const clientHalfHeightOffset = (ctx.canvas.clientHeight / 2) / scale
        const clientHeightOffset = ctx.canvas.clientHeight / scale

        const absoluteTop = translate.y - clientHalfHeightOffset
        const absoluteBottom = translate.y + clientHalfHeightOffset

        // epoch grid
        const colorA = "#FFFFFF"
        const colorB = "#CCFFFF"
        const minEpochStartOffset = leftMostPosition.x - SLOT_HALF_WIDTH + ((minSlot - leftMostNodeSlot) * SLOT_WIDTH)
        const epochWidth = SLOT_PER_EPOCH * SLOT_WIDTH

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
          const slotLabel = slot + " (" + slot % SLOT_PER_EPOCH + ")"
          let slotDiff: number = slot - leftMostNodeSlot
          ctx.beginPath()
          let slotCenter = slotDiff * SLOT_WIDTH + leftMostPosition.x
          ctx.moveTo(slotCenter + SLOT_HALF_WIDTH, absoluteTop + 50)
          ctx.lineTo(slotCenter + SLOT_HALF_WIDTH, absoluteBottom)
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
  }, [network, networkNodes, heads, roots, firstPOSNode])

  return (
    <div className="App">
      <Modal
        isOpen={showSettings}
        contentLabel="Settings"
        ariaHideApp={false}
      >
        <button onClick={handleCloseSettings}>Close Settings</button>
        <br></br>
        <br></br>
        <label>
          Protoarray Endpoint:
          <input type="text" style={{ width: '500px' }} value={protoArrayEndpointEdit} onChange={handleUpdateEndpoint} />
        </label>
        <br></br>
        <br></br>
        <label>
          Refresh (ms):
          <input type="number" style={{ width: '100px' }} value={pollPeriodEdit} onChange={handleSetPollingPeriod} />
        </label>
        <br></br>
        <br></br>
        <label>
          Max history:
          <input type="number" style={{ width: '100px' }} value={pollMaxHistoryEdit} onChange={handleSetPollMaxHistory} />
        </label>
        <br></br>
        <br></br>
        <label>
          Source type
          <Dropdown options={Object.values(SourceType)} onChange={handleSourceType} value={sourceTypeEdit} placeholder="Select Source Type" />
        </label>
      </Modal>
      <div className="main">
        <div className="header">
          <button style={{ marginRight: 100 }} onClick={handleShowSettings}>Settings</button>
          <button onClick={handleLoadTestData}>load test data</button>
          <button onClick={handleImportData}>import</button>
          <button onClick={handleExportData}>export</button>
          <div style={{ marginLeft: 100, marginRight: 100 }} className="importantText heads" >{'Heads: ' + heads.length}</div>
          <button onClick={handleCanonicalHead}>Center on canonical head</button>
          <button style={{ marginLeft: 100 }} onClick={handlePreviousHead}>&lt;</button>
          Cycle heads
          <button onClick={handleNextHead}>&gt;</button>
          <div style={{ marginLeft: 100, width: 400, display: 'inline-flex' }}>
            Node Size mode
            <Dropdown controlClassName='myControlClassName' options={Object.values(NodeSizeMode)} onChange={handleNodeSizeMode} value={nodeSizeMode} placeholder="Select Note Size Mode" />
          </div>

          <input type='file' id='file' onChange={(e: any) => readFileOnUpload(e.target.files[0])} ref={inputFile} style={{ display: 'none' }} />
        </div>
        <div className="network">
          <VisNetworkReactComponent
            data={data}
            options={{
              height: '95%',
              layout: {
                randomSeed: 2,
                hierarchical: {
                  enabled: true,
                  direction: 'LR',
                  sortMethod: 'directed',
                  levelSeparation: SLOT_WIDTH
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
                enabled: true,
                hierarchicalRepulsion: {
                  nodeDistance: SLOT_WIDTH + 1,
                },
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
          <div style={{ width: '33%' }}>
            <label>
              <input type="checkbox"
                defaultChecked={poll}
                onChange={() => togglePoll(!poll)}
              />
              Poll endpoint for data
            </label>
          </div>
          <div style={{ width: '33%' }}>
            <label>
              <input type="checkbox"
                checked={followPoll}
                onChange={() => setFollowPoll(!followPoll)}
              />
              Follow Polling
            </label>
          </div>
          <div style={{ width: '33%' }}>
            <label>
              <input type="checkbox"
                checked={followCanonicalHead}
                onChange={() => setFollowCanonicalHead(!followCanonicalHead)}
              />
              Always center on canonical head
            </label>
          </div>
          <div className="importantText">{forckchoiceDumpArray?.length > 0 ? forckchoiceDumpArray[0].timestamp.toLocaleString() : 'N/A'}</div>
          <div className="slider">

            <Range renderTrack={({ props, children }) => (
              <div
                onMouseDown={props.onMouseDown}
                onTouchStart={props.onTouchStart}
                style={{
                  ...props.style,
                  height: "36px",
                  display: "flex",
                  width: "100%"
                }}
              >
                <div
                  ref={props.ref}
                  style={{
                    height: "5px",
                    width: "100%",
                    borderRadius: "4px",
                    background: getTrackBackground({
                      values: [currentForckchoiceDumpIdx],
                      colors: ["#548BF4", "#ccc"],
                      min: 0,
                      max: forckchoiceDumpArray.length - 1
                    }),
                    alignSelf: "center"
                  }}
                >
                  {children}
                </div>
              </div>
            )}
              renderThumb={({ props, isDragged }) => (
                <div
                  {...props}
                  style={{
                    ...props.style,
                    height: '42px',
                    width: '21px',
                    borderRadius: '4px',
                    backgroundColor: '#FFF',
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    boxShadow: '0px 2px 6px #AAA'
                  }}
                >
                  {forckchoiceDumpArray.length > 0 &&
                    <div
                      style={{
                        position: 'absolute',
                        top: '48px',
                        color: '#fff',
                        fontWeight: 'bold',
                        fontSize: '14px',
                        fontFamily: 'Arial,Helvetica Neue,Helvetica,sans-serif',
                        padding: '4px',
                        borderRadius: '4px',
                        backgroundColor: '#548BF4'
                      }}
                    >
                      {forckchoiceDumpArray[currentForckchoiceDumpIdx]?.timestamp.local().format('HH:mm:ss')}
                    </div>}
                  <div
                    style={{
                      height: '16px',
                      width: '5px',
                      backgroundColor: isDragged ? '#548BF4' : '#CCC'
                    }}
                  />
                </div>
              )}
              renderMark={({ props, index }) => (
                <div
                  {...props}
                  style={{
                    ...props.style,
                    height: '16px',
                    width: '5px',
                    backgroundColor: index < currentForckchoiceDumpIdx ? '#548BF4' : '#ccc'
                  }}
                />
              )}
              min={0} max={Math.max(1, forckchoiceDumpArray.length - 1)}
              step={1}
              values={[currentForckchoiceDumpIdx]}
              onChange={handleSlide} />

          </div>

          <div className="importantText">{forckchoiceDumpArray?.length > 0 ? forckchoiceDumpArray[forckchoiceDumpArray.length - 1].timestamp.toLocaleString() : 'N/A'}</div>
        </div>
      </div>
    </div>
  )
}

export default App
