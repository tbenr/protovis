// Fork choice debug API access (v2 with v1 fallback) and the pure helpers that
// turn v2 (Gloas-aware) nodes into a tree.
//
// v2 (https://github.com/ethereum/beacon-APIs/pull/615) emits one node per
// (block_root, payload_status). Per block there is a base PENDING node, an EMPTY
// child and, once the payload is revealed, a FULL child. A child block's PENDING
// node inherits its parent's execution block hash, which tells whether it builds
// on the parent's FULL payload (hash matches the FULL node) or on EMPTY.

import { normalizeBaseUrl } from './beaconApi'

export type ForkChoiceApiVersion = 'unknown' | 'v1' | 'v2'
export type PayloadStatus = 'pending' | 'empty' | 'full'

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>

export function forkChoiceUrlV1(base: string): string {
  return `${normalizeBaseUrl(base)}/eth/v1/debug/fork_choice`
}

export function forkChoiceUrlV2(base: string): string {
  return `${normalizeBaseUrl(base)}/eth/v2/debug/fork_choice`
}

// Accepts both the plain beacon-APIs shape and a { data: ... } wrapped one (Teku).
export function unwrapForkChoiceResponse(body: any): any {
  const data = body && typeof body === 'object' && 'data' in body && !('fork_choice_nodes' in body) ? body.data : body
  if (!Array.isArray(data?.fork_choice_nodes)) throw new Error('response has no fork_choice_nodes')
  return data
}

async function getForkChoice(fetchFn: FetchLike, url: string) {
  const res = await fetchFn(url)
  return { res, url }
}

export async function fetchForkChoice(
  base: string,
  knownVersion: ForkChoiceApiVersion,
  fetchFn: FetchLike = fetch
): Promise<{ version: ForkChoiceApiVersion; data: any }> {
  if (knownVersion !== 'v1') {
    const { res, url } = await getForkChoice(fetchFn, forkChoiceUrlV2(base))
    if (res.ok) return { version: 'v2', data: unwrapForkChoiceResponse(await res.json()) }
    const notSupported = res.status === 404 || res.status === 405 || res.status === 501
    if (!notSupported || knownVersion === 'v2') throw new Error(`HTTP ${res.status} from ${url}`)
  }
  const { res, url } = await getForkChoice(fetchFn, forkChoiceUrlV1(base))
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
  return { version: 'v1', data: unwrapForkChoiceResponse(await res.json()) }
}

export function isV2Node(node: any): boolean {
  return typeof node?.payload_status === 'string'
}

// Graph identity of a node: block root for v1, block root + payload status for v2.
export function forkChoiceNodeKey(node: any): string {
  return isV2Node(node) ? `${node.block_root}:${node.payload_status}` : node.block_root
}

// Key of the node this one hangs from. `variantsOfRoot` returns every fork choice
// node sharing a block root (1 for v1/pre-Gloas, up to 3 for Gloas).
export function resolveParentKey(node: any, variantsOfRoot: (root: string) => any[]): string {
  if (isV2Node(node) && node.payload_status !== 'pending') {
    // EMPTY/FULL hang from their block's PENDING node. Pre-Gloas blocks are reported as a lone
    // FULL node without a PENDING variant: those resolve through parent_root like any block.
    const hasPending = variantsOfRoot(node.block_root).some(v => v.payload_status === 'pending')
    if (hasPending) return `${node.block_root}:pending`
  }
  const variants = variantsOfRoot(node.parent_root)
  if (variants.length === 0) return node.parent_root
  if (variants.length === 1) return forkChoiceNodeKey(variants[0])

  const full = variants.find(v => v.payload_status === 'full')
  if (full && full.execution_block_hash === node.execution_block_hash) return forkChoiceNodeKey(full)
  const empty = variants.find(v => v.payload_status === 'empty')
  if (empty) return forkChoiceNodeKey(empty)
  const pending = variants.find(v => v.payload_status === 'pending')
  return pending ? forkChoiceNodeKey(pending) : forkChoiceNodeKey(variants[0])
}

export type PtcVoteFractions = {
  yes: number         // availability-yes votes / PTC size
  votedNotYes: number // (attesters - availability-yes) / PTC size
  dataYes: number     // data-availability-yes votes / PTC size
}

function count(node: any, field: string): number {
  const n = Number(node?.[field] ?? node?.extra_data?.[field] ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// Shares of the whole committee, each capped to [0, 1]; the two outer segments never exceed 1 together.
export function ptcVoteFractions(node: any, ptcSize: number): PtcVoteFractions {
  const size = ptcSize > 0 ? ptcSize : 1
  const yes = Math.min(count(node, 'payload_availability_yes_count'), size)
  const voted = Math.min(Math.max(count(node, 'payload_attester_count'), yes), size)
  const dataYes = Math.min(count(node, 'payload_data_availability_yes_count'), size)
  return { yes: yes / size, votedNotYes: (voted - yes) / size, dataYes: dataYes / size }
}
