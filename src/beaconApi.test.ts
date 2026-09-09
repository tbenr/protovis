import { forkChoiceUrl, fetchNodeParams, normalizeBaseUrl } from './beaconApi'

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
      'http://node:5051/eth/v1/config/spec': { data: { SECONDS_PER_SLOT: '6' } },
    })
    await expect(fetchNodeParams('http://node:5051/', fetch)).resolves.toEqual({
      genesisTime: 1700000000,
      secondsPerSlot: 6,
    })
  })

  it('reads the PTC size when the spec has it', async () => {
    const fetch = mockFetch({
      'http://node:5051/eth/v1/beacon/genesis': { data: { genesis_time: '1700000000' } },
      'http://node:5051/eth/v1/config/spec': { data: { SECONDS_PER_SLOT: '6', PTC_SIZE: '16' } },
    })
    await expect(fetchNodeParams('http://node:5051', fetch)).resolves.toMatchObject({ ptcSize: 16 })
  })

  it('throws a descriptive error when a request fails', async () => {
    const fetch = mockFetch({
      'http://node:5051/eth/v1/config/spec': { data: { SECONDS_PER_SLOT: '12' } },
    })
    await expect(fetchNodeParams('http://node:5051', fetch)).rejects.toThrow(/genesis.*404/)
  })

  it('throws when the response lacks the expected fields', async () => {
    const fetch = mockFetch({
      'http://node:5051/eth/v1/beacon/genesis': { data: {} },
      'http://node:5051/eth/v1/config/spec': { data: { SECONDS_PER_SLOT: '12' } },
    })
    await expect(fetchNodeParams('http://node:5051', fetch)).rejects.toThrow(/genesis_time/)
  })
})
