// Helpers for talking to a beacon node over the standard Beacon API
// (https://github.com/ethereum/beacon-APIs). All functions take the node's
// base URL, e.g. "http://localhost:5051". An empty base means same-origin,
// which is what the bundled server/ proxy expects.

export type NodeParams = {
  genesisTime: number
  secondsPerSlot: number
  slotsPerEpoch: number
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
    slotsPerEpoch: requirePositiveNumber(spec?.data?.SLOTS_PER_EPOCH, 'SLOTS_PER_EPOCH', 'spec'),
    ...(Number.isFinite(ptcSize) && ptcSize > 0 ? { ptcSize } : {}),
  }
}

// Why did a fetch fail? Browsers report CORS blocks, refused connections and DNS failures all as
// a bare "Failed to fetch". A no-cors probe tells them apart: it resolves (opaque response) when
// the server answered at all, and rejects only when nothing is listening. Mixed content is
// decided from the URLs alone.
export type FetchFailureKind = 'cors' | 'unreachable' | 'mixed-content' | 'proxy' | 'other'

export type FetchFailure = {
  kind: FetchFailureKind
  message: string
}

type ProbeFetch = (url: string, init?: RequestInit) => Promise<unknown>

export async function diagnoseFetchFailure(
  base: string,
  error: unknown,
  pageOrigin: string = window.location.origin,
  fetchFn: ProbeFetch = fetch
): Promise<FetchFailure> {
  const message = error instanceof Error ? error.message : String(error)
  const isNetworkError = error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(message)
  if (!isNetworkError) return { kind: 'other', message }

  const endpoint = normalizeBaseUrl(base)
  if (endpoint === '') {
    return {
      kind: 'proxy',
      message: `${message}: the app is using its own origin (${pageOrigin}) as node URL, so the bundled proxy must serve it with PROTO_ENDPOINT set`,
    }
  }
  if (pageOrigin.startsWith('https:') && /^http:/i.test(endpoint)) {
    return {
      kind: 'mixed-content',
      message: `${message}: this page is served over https but the node URL is http, which browsers block as mixed content; use an https node URL or the bundled proxy`,
    }
  }
  try {
    await fetchFn(genesisUrl(endpoint), { mode: 'no-cors', cache: 'no-store' })
  } catch (e) {
    return { kind: 'unreachable', message: `${message}: cannot reach ${endpoint} (connection refused, host unknown or node down)` }
  }
  return {
    kind: 'cors',
    message: `${message}: ${endpoint} answers but likely blocks cross-origin requests from ${pageOrigin}. Allow this origin on the node (Teku: --rest-api-cors-origins="${pageOrigin}") or serve the app through the bundled proxy (see README)`,
  }
}
