#!/usr/bin/env node
// Generates src/testDataGloas.json: a synthetic /eth/v2/debug/fork_choice response
// (Teku layout: PTC counts at top level) covering the interesting Gloas cases.
//
//   node scripts/genGloasTestData.js
//
// Scenario (mainnet-like: 12s slots, PTC size 512, genesis = app default so late markers work):
//
//   100 ─ 101 ─ 102 ─ 103        pre-Gloas, lone "full" nodes
//   104 A   pending ─ full(512/512) ─┐   empty w=0 (hidden by default)
//   105 B   pending ─ full(300/400) ─── 106 D pending ─ full(512, optimistic) ─ 107 E pending ─ empty(w>0, payload never revealed)
//               └─ empty(w>0) ──────── 106 C pending ─ full(480/500, invalid)          └─ 108 F pending ─ empty ─ 110 G pending (+ empty w=0)
//                                                                                          └─ full(40/350) ─ 111 H pending ─ empty(w>0, a head)
//                                                                                             ↑ received 1 slot late
//   109 skipped (missing-slot diamond)
//
// Weights are proto-array style: a node's weight includes its whole subtree.

const fs = require('fs')
const path = require('path')

const GENESIS_TIME = 1606824023 // mainnet, the app default when no node is connected
const SECONDS_PER_SLOT = 12
const G = 1_000_000_000 // 1 ETH of effective balance in gwei, used as weight unit

const hex = (name) => '0x' + Buffer.from(name.padEnd(32, '_'), 'ascii').toString('hex').slice(0, 64)
// block roots start with the block name, payload hashes with "p" + name, so label prefixes stay tellable apart
const root = (name) => hex(name.padEnd(4, '_') + '_root')
const payload = (name) => hex('p' + name.padEnd(3, '_') + '_payload')
const ZERO = '0x' + '0'.repeat(64)

// blocks: name, slot, parent block, which parent variant it builds on ('full' | 'empty' | 'single')
const blocks = [
  { name: '100', slot: 100, parent: null, preGloas: true, payloadHash: payload('100'), weight: 1960 },
  { name: '101', slot: 101, parent: '100', preGloas: true, payloadHash: payload('101'), weight: 1860 },
  { name: '102', slot: 102, parent: '101', preGloas: true, payloadHash: payload('102'), weight: 1760 },
  { name: '103', slot: 103, parent: '102', preGloas: true, payloadHash: payload('103'), weight: 1640 },
  { name: 'A', slot: 104, parent: '103', on: 'single', payloadHash: payload('A'),
    pending: 1540, empty: 0, full: 1540, ptc: [512, 512, 512], validity: 'valid' },
  { name: 'B', slot: 105, parent: 'A', on: 'full', payloadHash: payload('B'),
    pending: 1240, empty: 300, full: 940, ptc: [300, 400, 280], validity: 'valid' },
  { name: 'C', slot: 106, parent: 'B', on: 'empty', payloadHash: payload('C'),
    pending: 300, empty: 0, full: 300, ptc: [480, 500, 470], validity: 'invalid' },
  { name: 'D', slot: 106, parent: 'B', on: 'full', payloadHash: payload('D'),
    pending: 840, empty: 0, full: 840, ptc: [512, 512, 512], validity: 'optimistic' },
  { name: 'E', slot: 107, parent: 'D', on: 'full', payloadHash: null, // payload never revealed
    pending: 440, empty: 440, ptc: [0, 0, 0], validity: 'valid' },
  { name: 'F', slot: 108, parent: 'E', on: 'empty', payloadHash: payload('F'),
    pending: 240, empty: 150, full: 90, ptc: [40, 350, 35], validity: 'valid', receivedAtSlot: 109 },
  { name: 'G', slot: 110, parent: 'F', on: 'empty', payloadHash: null, // payload still pending
    pending: 100, empty: 0, ptc: [0, 0, 0], validity: 'valid' },
  { name: 'H', slot: 111, parent: 'F', on: 'full', payloadHash: null, // payload never revealed, EMPTY node voted for: a head
    pending: 60, empty: 60, ptc: [0, 0, 0], validity: 'valid' },
]

const byName = Object.fromEntries(blocks.map(b => [b.name, b]))

// execution_block_hash inherited by a block's pending/empty nodes: the hash of the parent variant it builds on
function inheritedHash(b) {
  if (!b.parent) return ZERO
  const p = byName[b.parent]
  if (b.on === 'full' || b.on === 'single') return p.payloadHash
  return inheritedHash(p) // built on parent's EMPTY: carries whatever the parent inherited
}

function node(b, status, weight, ebh) {
  const n = {
    payload_status: status,
    slot: String(b.slot),
    block_root: root(b.name),
    parent_root: b.parent ? root(b.parent) : ZERO,
    weight: String(BigInt(weight) * BigInt(G)),
    validity: status === 'full' ? (b.validity ?? 'valid') : 'valid',
    execution_block_hash: ebh,
    payload_attester_count: String(b.ptc ? b.ptc[1] : 0),
    payload_availability_yes_count: String(b.ptc ? b.ptc[0] : 0),
    payload_data_availability_yes_count: String(b.ptc ? b.ptc[2] : 0),
    extra_data: {
      timestamp: String(GENESIS_TIME + (b.receivedAtSlot ?? b.slot) * SECONDS_PER_SLOT),
      synthetic_block: b.name,
    },
  }
  return n
}

const nodes = []
for (const b of blocks) {
  if (b.preGloas) {
    nodes.push(node(b, 'full', b.weight, b.payloadHash))
    continue
  }
  const inherited = inheritedHash(b)
  nodes.push(node(b, 'pending', b.pending, inherited))
  nodes.push(node(b, 'empty', b.empty, inherited))
  if (b.payloadHash) nodes.push(node(b, 'full', b.full, b.payloadHash))
}

const out = {
  justified_checkpoint: { epoch: '12', root: root('100') },
  finalized_checkpoint: { epoch: '11', root: root('100') },
  fork_choice_nodes: nodes,
  extra_data: { synthetic: true, generator: 'scripts/genGloasTestData.js' },
}

const target = path.join(__dirname, '..', 'src', 'testDataGloas.json')
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n')
console.log(`wrote ${target}: ${nodes.length} nodes`)
