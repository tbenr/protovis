// Helpers for talking to a beacon node over the standard Beacon API
// (https://github.com/ethereum/beacon-APIs). All functions take the node's
// base URL, e.g. "http://localhost:5051". An empty base means same-origin,
// which is what the bundled server/ proxy expects.

export type NodeParams = {
  genesisTime: number
  secondsPerSlot: number
  ptcSize?: number // Gloas Payload Timeliness Committee size, absent on pre-Gloas specs
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>

export function normalizeBaseUrl(base: string): string {
  return base.trim().replace(/\/+$/, '')
}

export function forkChoiceUrl(base: string): string {
  return `${normalizeBaseUrl(base)}/eth/v1/debug/fork_choice`
}

export function genesisUrl(base: string): string {
  return `${normalizeBaseUrl(base)}/eth/v1/beacon/genesis`
}

export function specUrl(base: string): string {
  return `${normalizeBaseUrl(base)}/eth/v1/config/spec`
}

async function getJson(fetchFn: FetchLike, url: string, what: string): Promise<any> {
  const res = await fetchFn(url)
  if (!res.ok) throw new Error(`${what} request failed: HTTP ${res.status} from ${url}`)
  return res.json()
}

function requirePositiveNumber(value: unknown, field: string, what: string): number {
  const n = Number(value)
  if (value === undefined || value === null || !Number.isFinite(n) || n <= 0) {
    throw new Error(`${what} response has no valid ${field}`)
  }
  return n
}

// Reads genesis time and slot duration from the connected node.
export async function fetchNodeParams(base: string, fetchFn: FetchLike = fetch): Promise<NodeParams> {
  const [genesis, spec] = await Promise.all([
    getJson(fetchFn, genesisUrl(base), 'genesis'),
    getJson(fetchFn, specUrl(base), 'spec'),
  ])
  const ptcSize = Number(spec?.data?.PTC_SIZE)
  return {
    genesisTime: requirePositiveNumber(genesis?.data?.genesis_time, 'genesis_time', 'genesis'),
    secondsPerSlot: requirePositiveNumber(spec?.data?.SECONDS_PER_SLOT, 'SECONDS_PER_SLOT', 'spec'),
    ...(Number.isFinite(ptcSize) && ptcSize > 0 ? { ptcSize } : {}),
  }
}
