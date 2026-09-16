import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_REGIME_SETTINGS,
  REGIME_SETTINGS_KEY,
  cloneRegimeSettings,
  readRegimeSettings,
  saveRegimeSettings,
  validReading,
  validRegimeSettings,
  zoneOf,
} from './market-regime'

afterEach(() => {
  localStorage.clear()
})

describe('market regime settings', () => {
  it('accepts the documented defaults and rejects out-of-range or non-finite values', () => {
    expect(validRegimeSettings(DEFAULT_REGIME_SETTINGS)).toBe(true)
    const settings = cloneRegimeSettings(DEFAULT_REGIME_SETTINGS)
    settings.inputs.fear_greed = { value: 101, as_of: null }
    expect(validRegimeSettings(settings)).toBe(false)
    settings.inputs.fear_greed = { value: 55, as_of: '2026-09-04' }
    expect(validRegimeSettings(settings)).toBe(true)
    settings.inputs.shiller_pe = { value: Number.NaN, as_of: null }
    expect(validRegimeSettings(settings)).toBe(false)
    settings.inputs.shiller_pe = { value: 38, as_of: '04/09/2026' }
    expect(validRegimeSettings(settings)).toBe(false)
    settings.inputs.shiller_pe = null
    settings.weights.technical = 101
    expect(validRegimeSettings(settings)).toBe(false)
    settings.weights = { buffett: 0, shiller: 0, yield_curve: 0, technical: 0, sentiment: 0 }
    expect(validRegimeSettings(settings)).toBe(false)
    expect(validRegimeSettings({ ...DEFAULT_REGIME_SETTINGS, benchmark: 'TQQQ' })).toBe(false)
    expect(validReading({ value: -6, as_of: null }, 'yield_2y')).toBe(false)
    expect(validReading({ value: 4.2, as_of: null }, 'yield_2y')).toBe(true)
  })
  it('falls back to defaults on corrupt storage and round-trips saved settings', () => {
    localStorage.setItem(REGIME_SETTINGS_KEY, '{"version":1,"weights":{"buffett":"x"}}')
    expect(readRegimeSettings()).toEqual(DEFAULT_REGIME_SETTINGS)
    const settings = cloneRegimeSettings(DEFAULT_REGIME_SETTINGS)
    settings.benchmark = 'QQQ'
    settings.inputs.buffett_ratio = { value: 190, as_of: '2026-06-30' }
    saveRegimeSettings(settings)
    expect(readRegimeSettings()).toEqual(settings)
    expect(readRegimeSettings()).not.toBe(settings)
  })
  it('keeps working when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readRegimeSettings()).toEqual(DEFAULT_REGIME_SETTINGS)
    expect(() => saveRegimeSettings(DEFAULT_REGIME_SETTINGS)).not.toThrow()
  })
  it('maps scores to zones at the documented boundaries', () => {
    expect(zoneOf(null)).toBeNull()
    expect(zoneOf(Number.NaN)).toBeNull()
    expect(zoneOf(39.9)).toBe('calm')
    expect(zoneOf(40)).toBe('watch')
    expect(zoneOf(60)).toBe('elevated')
    expect(zoneOf(79.99)).toBe('elevated')
    expect(zoneOf(80)).toBe('extreme')
  })
})
