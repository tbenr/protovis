import { forkChoiceUrl, fetchNodeParams, normalizeBaseUrl, diagnoseFetchFailure } from './beaconApi'

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes and whitespace', () => {
    expect(normalizeBaseUrl(' http://localhost:5051/ ')).toBe('http://localhost:5051')
    expect(normalizeBaseUrl('http://localhost:5051//')).toBe('http://localhost:5051')
  })

  it('keeps a bare base untouched', () => {
    expect(normalizeBaseUrl('http://localhost:5051')).toBe('http://localhost:5051')
  })

  it('allows an empty base for same-origin proxying', () => {
    expect(normalizeBaseUrl('')).toBe('')
    expect(normalizeBaseUrl('/')).toBe('')
  })
})

describe('forkChoiceUrl', () => {
  it('appends the standard debug fork_choice path', () => {
    expect(forkChoiceUrl('http://localhost:5051/')).toBe('http://localhost:5051/eth/v1/debug/fork_choice')
    expect(forkChoiceUrl('')).toBe('/eth/v1/debug/fork_choice')
  })
})

describe('fetchNodeParams', () => {
  const mockFetch = (responses: { [url: string]: any }) =>
    jest.fn(async (url: string) => {
      const body = responses[url]
      if (!body) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => body }
    }) as any

  it('reads genesis time and seconds per slot from the node', async () => {
    const fetch = mockFetch({
      'http://node:5051/eth/v1/beacon/genesis': { data: { genesis_time: '1700000000' } },
      'http://node:5051/eth/v1/config/spec': { data: { SECONDS_PER_SLOT: '6', SLOTS_PER_EPOCH: '8' } },
    })
    await expect(fetchNodeParams('http://node:5051/', fetch)).resolves.toEqual({
      genesisTime: 1700000000,
      secondsPerSlot: 6,
      slotsPerEpoch: 8,
    })
  })

  it('reads the PTC size when the spec has it', async () => {
    const fetch = mockFetch({
      'http://node:5051/eth/v1/beacon/genesis': { data: { genesis_time: '1700000000' } },
      'http://node:5051/eth/v1/config/spec': { data: { SECONDS_PER_SLOT: '6', SLOTS_PER_EPOCH: '8', PTC_SIZE: '16' } },
    })
    await expect(fetchNodeParams('http://node:5051', fetch)).resolves.toMatchObject({ ptcSize: 16 })
  })

  it('throws a descriptive error when a request fails', async () => {
    const fetch = mockFetch({
      'http://node:5051/eth/v1/config/spec': { data: { SECONDS_PER_SLOT: '12', SLOTS_PER_EPOCH: '32' } },
    })
    await expect(fetchNodeParams('http://node:5051', fetch)).rejects.toThrow(/genesis.*404/)
  })

  it('throws when the response lacks the expected fields', async () => {
    const fetch = mockFetch({
      'http://node:5051/eth/v1/beacon/genesis': { data: {} },
      'http://node:5051/eth/v1/config/spec': { data: { SECONDS_PER_SLOT: '12', SLOTS_PER_EPOCH: '32' } },
    })
    await expect(fetchNodeParams('http://node:5051', fetch)).rejects.toThrow(/genesis_time/)
  })
})

describe('diagnoseFetchFailure', () => {
  const failed = new TypeError('Failed to fetch')
  const origin = 'http://localhost:3000'

  it('reports CORS when the no-cors probe reaches the node', async () => {
    const probe = jest.fn(async () => ({ type: 'opaque' })) as any
    const result = await diagnoseFetchFailure('http://node:5051', failed, origin, probe)
    expect(result.kind).toBe('cors')
    expect(result.message).toMatch(/--rest-api-cors-origins="http:\/\/localhost:3000"/)
    expect(probe).toHaveBeenCalledWith('http://node:5051/eth/v1/beacon/genesis', expect.objectContaining({ mode: 'no-cors' }))
  })

  it('reports unreachable when the probe fails too', async () => {
    const probe = jest.fn(async () => { throw new TypeError('Failed to fetch') }) as any
    const result = await diagnoseFetchFailure('http://node:5051', failed, origin, probe)
    expect(result.kind).toBe('unreachable')
    expect(result.message).toMatch(/cannot reach http:\/\/node:5051/)
  })

  it('reports mixed content without probing', async () => {
    const probe = jest.fn() as any
    const result = await diagnoseFetchFailure('http://node:5051', failed, 'https://protovis.example', probe)
    expect(result.kind).toBe('mixed-content')
    expect(probe).not.toHaveBeenCalled()
  })

  it('points at the proxy for an empty node URL', async () => {
    const result = await diagnoseFetchFailure('', failed, origin, jest.fn() as any)
    expect(result.kind).toBe('proxy')
    expect(result.message).toMatch(/PROTO_ENDPOINT/)
  })

  it('passes non-network errors through', async () => {
    const result = await diagnoseFetchFailure('http://node:5051', new Error('HTTP 500 from x'), origin, jest.fn() as any)
    expect(result).toEqual({ kind: 'other', message: 'HTTP 500 from x' })
  })
})
