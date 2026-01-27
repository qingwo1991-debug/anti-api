/**
 * Server-side Settings Service
 * Stores user preferences in a JSON file
 */

import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "fs"
import { join } from "path"
import { ensureDataDir, getDataDir } from "~/lib/data-dir"

const SETTINGS_DIR = getDataDir()
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json")

export interface AppSettings {
    preloadRouting: boolean
    autoNgrok: boolean
    autoOpenDashboard: boolean
    autoRefresh: boolean
    autoRestart: boolean
    privacyMode: boolean
    compactLayout: boolean
    trackUsage: boolean
    optimizeQuotaSort: boolean
    captureLogs: boolean
    // 配额保留设置：当账户配额低于此百分比时切换到下一个账户
    quotaReservePercent: number
}

const DEFAULT_SETTINGS: AppSettings = {
    preloadRouting: true,
    autoNgrok: false,
    autoOpenDashboard: true,
    autoRefresh: true,
    autoRestart: false,
    privacyMode: false,
    compactLayout: false,
    trackUsage: true,
    optimizeQuotaSort: false,
    captureLogs: false,
    quotaReservePercent: 0, // 默认不保留，0 表示用尽才切换
}

function ensureSettingsDir(): void {
    ensureDataDir()
}

export function loadSettings(): AppSettings {
    try {
        ensureSettingsDir()
        if (existsSync(SETTINGS_FILE)) {
            const data = readFileSync(SETTINGS_FILE, "utf-8")
            return { ...DEFAULT_SETTINGS, ...JSON.parse(data) }
        }
    } catch (error) {
        // Ignore errors, return defaults
    }
    return { ...DEFAULT_SETTINGS }
}

export function saveSettings(settings: Partial<AppSettings>): AppSettings {
    ensureSettingsDir()
    const current = loadSettings()
    const updated = { ...current, ...settings }
    const payload = JSON.stringify(updated, null, 2)
    const tmpFile = `${SETTINGS_FILE}.tmp`
    writeFileSync(tmpFile, payload, "utf-8")
    try {
        renameSync(tmpFile, SETTINGS_FILE)
    } catch {
        try {
            rmSync(SETTINGS_FILE, { force: true })
        } catch {
            // Ignore cleanup failures, rename will throw if it still can't proceed.
        }
        renameSync(tmpFile, SETTINGS_FILE)
    }
    return updated
}

export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return loadSettings()[key]
}
