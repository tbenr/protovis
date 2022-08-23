import React, { useCallback, useState, useEffect, useMemo, useRef } from "react"
import './App.css'
import moment from 'moment'

import BigNumber from "bignumber.js"
import VisNetworkReactComponent from "vis-network-react"
import { Range, getTrackBackground } from 'react-range'
import Modal from 'react-modal'

import hljs from 'highlight.js'
import 'highlight.js/styles/default.css'

const SLOT_WIDTH: number = 150
const SLOT_HALF_WIDTH: number = SLOT_WIDTH / 2
const SLOT_PER_EPOCH: number = 32

const DEFAULT_POLLING_PERIOD: number = 6000
const DEFAULT_ENDPOINT: string = 'http://localhost:5051/teku/v1/debug/beacon/protoarray'
const DEFAULT_POLL_MAX_HISTORY: number = 50

const COLOR_VALID: string = 'green'
const COLOR_INVALID: string = 'red'
const COLOR_OPTIMISTIC: string = 'grey'

const pollActiveAtStartup: boolean = false

interface ProtoArraySample {
  timestamp: moment.Moment
  protoArray: any
}

const defaultdata = {
  nodes: [
  ],
  edges: [
  ],
}

function htmlTitle(html) {
  const container = document.createElement("div")
  container.style.cssText = 'text-align: left;'
  container.innerHTML = html
  return container
}


function validationStatusToColor(validationStatus) {
  switch (validationStatus) {
    case 'VALID':
      return COLOR_VALID
    case 'INVALID':
      return COLOR_INVALID
    case 'OPTIMISTIC':
      return COLOR_OPTIMISTIC
  }
}

/**
 * 
 * Teku Specific
 * prerequisite:
 *  node.id must be blockRoot
 *  node.level must set as its slot
 *  node.value must be proportional to its weight
 */
function protoArrayToNetworkData(protoArray) {
  let nodes: any = {}
  let edges: any = []
  let heads: any = {}

  protoArray.forEach(protoNode => {
    let isMerge = protoNode.executionBlockHash !== '0x0000000000000000000000000000000000000000000000000000000000000000'
    let label = isMerge ? '🐼 ': ''
    label += protoNode.blockRoot.substring(0, 8)
    nodes[protoNode.blockRoot] = {
      id: protoNode.blockRoot,
      title: htmlTitle('<i>single-click to copy blockRoot, double-click to copy all</i><pre><code id="jsonNodeInfo" class="language-json">' + JSON.stringify(protoNode, null, ' ') + '</code></pre>'),
      label: label,
      level: parseInt(protoNode.slot),
      value: BigNumber(protoNode.weight).dividedBy(10000).toNumber(),
      color: validationStatusToColor(protoNode.validationStatus),
      protoNode: protoNode,
      isMerge: isMerge
    }
    edges.push({ from: protoNode.blockRoot, to: protoNode.parentRoot })
    heads[protoNode.blockRoot] = protoNode.slot
  })

  protoArray.forEach(protoNode => {
    delete heads[protoNode.parentRoot]

    let parent = nodes[protoNode.parentRoot]
    let node = nodes[protoNode.blockRoot]

    if(parent === undefined) {
      node.isFirstPOS = false
      return
    }

    if(parent.isMerge === false && node.isMerge === true) {
      node.isFirstPOS = true
    } else {
      node.isFirstPOS = false
    }
   })

  Object.keys(heads).forEach(head => {
    nodes[head].isHead = true
  })

  return {
    heads: Object.keys(heads).sort((a, b) => BigNumber(heads[b]).comparedTo(heads[a])),
    networkData: {
      nodes: Object.values(nodes) as any,
      edges: edges
    }
  }
}

function App() {
  const [showSettings, setShowSettings] = useState<boolean>(false)

  const [protoArraySamples, setProtoArraySamples] = useState<ProtoArraySample[]>([])
  const [fetchedProtoArraySample, setFetchedProtoArraySample] = useState<any>()
  const [currentProtoArraySampleIdx, setCurrentProtoArraySampleIdx] = useState<number>(0)
  const [data, setData] = useState(defaultdata)
  const [heads, setHeads] = useState<string[]>([])
  const [headIdx, setheadIdx] = useState<number>(0)
  const [networkNodes, setNetwortNodes] = useState<any>([])
  const [network, setNetwort] = useState<any>()

  const [poll, setPoll] = useState<boolean>(pollActiveAtStartup)
  const [pollTimer, setPollTimer] = useState<any>(0)
  const [followPoll, setFollowPoll] = React.useState(true)
  const [followMostRectentHead, setFollowMostRectentHead] = React.useState(true);

  // settings
  const [protoArrayEndpoint, setProtoArrayEndpoint] = useState<string>(DEFAULT_ENDPOINT)
  const [pollPeriod, setPollPeriod] = useState<number>(DEFAULT_POLLING_PERIOD)
  const [pollMaxHistory, setPollMaxHistory] = useState<number>(DEFAULT_POLL_MAX_HISTORY)

  // settings edit
  const [protoArrayEndpointEdit, setProtoArrayEndpointEdit] = useState<string>(DEFAULT_ENDPOINT)
  const [pollPeriodEdit, setPollPeriodEdit] = useState<number>(DEFAULT_POLLING_PERIOD)
  const [pollMaxHistoryEdit, setPollMaxHistoryEdit] = useState<number>(DEFAULT_POLL_MAX_HISTORY)

  const inputFile = useRef<any>(null)

  // poll protoarray endpoint
  const getProtoArray = useCallback(async () => {
    const res = await fetch(protoArrayEndpoint)
    const data = await res.json()
    setFetchedProtoArraySample(data)
  }, [setFetchedProtoArraySample, protoArrayEndpoint])

  // save history
  useEffect(() => {
    if (!fetchedProtoArraySample) return

    setProtoArraySamples(protoArraySamples => {
      while (protoArraySamples.length >= pollMaxHistory) {
        protoArraySamples.shift()
      }
      return [...protoArraySamples, { timestamp: moment(), protoArray: fetchedProtoArraySample }]
    }
    )
  }, [pollMaxHistory, fetchedProtoArraySample, setProtoArraySamples])

  // set current index vis, following latest updates
  useEffect(() => {
    if (!protoArraySamples || protoArraySamples.length === 0) return
    if (followPoll) {
      setCurrentProtoArraySampleIdx(protoArraySamples.length - 1)
    }
  }, [protoArraySamples, currentProtoArraySampleIdx, setCurrentProtoArraySampleIdx, followPoll])

  const handleMostRecentHead = useCallback(() => {
    if (heads.length === 0) return
    network.fit({
      nodes: [heads[0]],
      animation: true
    })
    setheadIdx(0)
  }, [heads, network, setheadIdx])

  // render current data
  useEffect(() => {
    if (protoArraySamples.length === 0 || currentProtoArraySampleIdx >= protoArraySamples.length) return
    const { heads, networkData } = protoArrayToNetworkData(protoArraySamples[currentProtoArraySampleIdx].protoArray)
    setHeads(heads)
    setData(networkData)
  }, [currentProtoArraySampleIdx, protoArraySamples, setData, setHeads])

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
    if (followMostRectentHead) {
      const timer = setTimeout(handleMostRecentHead, 200)
      return () => clearTimeout(timer)
    }
  }, [followMostRectentHead, handleMostRecentHead])

  const getNetwork = useCallback((a) => {
    setNetwort(a)
  }, [])

  const getNodes = useCallback((a) => {
    setNetwortNodes(a)
  }, [])

  const handleSlide = useCallback((values) => {
    const value = values[0]
    setCurrentProtoArraySampleIdx(parseInt(value))
    setFollowPoll(value === protoArraySamples.length - 1)
  }, [setCurrentProtoArraySampleIdx, setFollowPoll, protoArraySamples])


  const handleShowSettings = useCallback(() => {
    setShowSettings(true)
  }, [setShowSettings])


  const handleCloseSettings = useCallback(() => {
    setShowSettings(false)
    setProtoArrayEndpoint(protoArrayEndpointEdit)
    setPollPeriod(pollPeriodEdit)
    setPollMaxHistory(pollMaxHistoryEdit)

    if (poll) {
      clearInterval(pollTimer)
      const timer = setInterval(getProtoArray, pollPeriodEdit)
      setPollTimer(timer)
    }

  }, [setShowSettings, getProtoArray, pollTimer, poll, protoArrayEndpointEdit, pollPeriodEdit, pollMaxHistoryEdit, setProtoArrayEndpoint, setPollPeriod, setPollMaxHistory])

  const handleUpdateEndpoint = useCallback((event) => {
    setProtoArrayEndpointEdit(event.target.value)
  }, [setProtoArrayEndpointEdit])


  const handleSetPollingPeriod = useCallback((event) => {
    setPollPeriodEdit(event.target.value)
  }, [setPollPeriodEdit])

  const handleSetPollMaxHistory = useCallback((event) => {
    setPollMaxHistoryEdit(event.target.value)
  }, [setPollMaxHistoryEdit])

  const handlePreviousHead = useCallback(() => {
    if (heads.length === 0) return

    const previousHead = (headIdx + 1) % heads.length

    network.fit({
      nodes: [heads[previousHead]],
      animation: true
    })
    setheadIdx(previousHead)
  }, [network, heads, headIdx, setheadIdx])

  const handleNextHead = useCallback(() => {
    if (heads.length === 0) return

    const nextHead = (Math.max(0, headIdx - 1)) % heads.length

    network.fit({
      nodes: [heads[nextHead]],
      animation: true
    })
    setheadIdx(nextHead)
  }, [network, heads, headIdx, setheadIdx])

  const handleExportData = useCallback(() => {
    const jsonString = `data:text/json;chatset=utf-8,${encodeURIComponent(
      JSON.stringify(protoArraySamples, null, "\t")
    )}`
    const link = document.createElement("a")
    link.href = jsonString
    link.download = "protoarray_dumps.json"

    link.click()
  }, [protoArraySamples])

  const handleImportData = () => {
    if (!inputFile?.current) return
    inputFile.current.click()
  }

  const readFileOnUpload = useCallback((uploadedFile: any) => {
    const fileReader: any = new FileReader()
    fileReader.onloadend = () => {
      try {
        let data: any[] = JSON.parse(fileReader.result)
        if (data[0] !== undefined && data[0].timestamp === undefined) {
          // single protoarray
          setProtoArraySamples([{ timestamp: moment(), protoArray: data } as ProtoArraySample])
        } else {
          // multiple protoarrays
          for (let sample of data) {
            sample.timestamp = moment(sample.timestamp)
          }
          setProtoArraySamples(data)
        }
      } catch (e) {
        alert("**Not valid JSON file!**")
      }

      inputFile.current.value = null
    }
    if (uploadedFile !== undefined)
      fileReader.readAsText(uploadedFile)
  }, [setProtoArraySamples, inputFile])


  const events = useMemo(() => {
    return {
      click: function (params) {
        let node: any = (this as any).body.nodes[params.nodes[0]]
        if (!node) return
        let json: string = node.getTitle().childNodes[1].textContent
        let blockRoot: string = JSON.parse(json).blockRoot
        navigator.clipboard.writeText(blockRoot)
        params.event = "[original event]"
      },
      doubleClick: function (params) {
        let node: any = (this as any).body.nodes[params.nodes[0]]
        if (!node) return
        let json: string = node.getTitle().childNodes[1].textContent
        navigator.clipboard.writeText(json)
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

        let firstPOSNode: any

        networkNodes.forEach((node: any) => {
          if (!leftMostNode || node.level < minSlot) {
            minSlot = node.level
            leftMostNode = node
          }
          if (node.level > maxSlot) maxSlot = node.level

          if(node.isFirstPOS) {
            firstPOSNode = node
          }
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
        if(firstPOSNode) {
          const posLabel = '🐼 MERGE 🐼'
          const posNodePosition = network.getPosition(firstPOSNode.id)
          let x = posNodePosition.x - ctx.measureText(posLabel).width / 2
          ctx.fillText(posLabel, x, posNodePosition.y - 100)
        }
      },

      afterDrawing: function (ctx) {
        if (network === undefined || networkNodes === undefined || networkNodes.length === 0) return

        networkNodes.forEach((node: any) => {
          let idx = heads.indexOf(node.id)
          let nodePositions = network.getPositions(node.id)
          let position = nodePositions[node.id]
          if (isNaN(position.x)) return
          if (idx !== -1) {
            ctx.strokeStyle = "#A6D5F7"
            ctx.fillStyle = idx === headIdx ? "#FF4475" : "#004475"

          } else {
            ctx.strokeStyle = node.color
            ctx.fillStyle = node.color
          }

          ctx.beginPath()
          ctx.arc(
            position.x,
            position.y,
            5,
            0,
            2 * Math.PI,
            false
          )
          ctx.closePath()

          ctx.fill()
          ctx.stroke()
        })

      },
    }
  }, [network, networkNodes, heads, headIdx])

  return (
    <div className="App">
      <Modal
        isOpen={showSettings}
        contentLabel="Settings"
      >
        <button onClick={handleCloseSettings}>Close Settings</button>
        <br></br>
        <br></br>
        <label>
          Teku protoarray Endpoint:
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
      </Modal>
      <div className="main">
        <div className="header">
          <button style={{ marginRight: 100 }} onClick={handleShowSettings}>Settings</button>
          <button onClick={handleImportData}>import</button>
          <button onClick={handleExportData}>export</button>
          <div style={{ marginLeft: 150, marginRight: 150 }} className="importantText heads" >{'Heads: ' + heads.length}</div>
          <button onClick={handleMostRecentHead}>Go to most recent head</button>
          <button style={{ marginLeft: 100 }} onClick={handlePreviousHead}>&lt;</button>
          Cycle heads
          <button onClick={handleNextHead}>&gt;</button>

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
                scaling: { min: 10, max: 50 }
              },
              physics: {
                enabled: true
                //hierarchicalRepulsion: {
                //  nodeDistance: SLOT_WIDTH + 5,
                //},
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
                checked={followMostRectentHead}
                onChange={() => setFollowMostRectentHead(!followMostRectentHead)}
              />
              Follow most recent head
            </label>
          </div>
          <div className="importantText">{protoArraySamples?.length > 0 ? protoArraySamples[0].timestamp.toLocaleString() : 'N/A'}</div>
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
                      values: [currentProtoArraySampleIdx],
                      colors: ["#548BF4", "#ccc"],
                      min: 0,
                      max: protoArraySamples.length - 1
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
                  {protoArraySamples.length > 0 &&
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
                      {protoArraySamples[currentProtoArraySampleIdx]?.timestamp.local().format('HH:mm:ss')}
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
                    backgroundColor: index < currentProtoArraySampleIdx ? '#548BF4' : '#ccc'
                  }}
                />
              )}
              min={0} max={Math.max(1, protoArraySamples.length - 1)}
              step={1}
              values={[currentProtoArraySampleIdx]}
              onChange={handleSlide} />

          </div>

          <div className="importantText">{protoArraySamples?.length > 0 ? protoArraySamples[protoArraySamples.length - 1].timestamp.toLocaleString() : 'N/A'}</div>
        </div>
      </div>
    </div>
  )
}

export default App
