import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { randomUUID } from "crypto"
import consola from "consola"
import type { AuthProvider } from "~/services/auth/types"
import { isHiddenCodexModel } from "./models"
import { getDataDir } from "~/lib/data-dir"

export interface RoutingEntry {
    id: string
    provider: AuthProvider
    accountId: string
    modelId: string
    label: string
    accountLabel?: string
}

export interface AccountRoutingEntry {
    id: string
    provider: AuthProvider
    accountId: string
    label?: string
    accountLabel?: string
}

export interface AccountRoutingRoute {
    id: string
    modelId: string
    entries: AccountRoutingEntry[]
}

export interface AccountRoutingConfig {
    smartSwitch: boolean
    routes: AccountRoutingRoute[]
}

export interface RoutingFlow {
    id: string
    name: string
    entries: RoutingEntry[]
}

/**
 * 🆕 模型映射配置
 * 将请求的模型名称映射到 Antigravity 支持的模型
 */
export interface ModelMapping {
    id: string
    source: string      // 请求的模型名称（如 deepseek-v3）
    target: string      // Antigravity 支持的模型（如 gemini-2.5-pro）
    enabled: boolean    // 是否启用
}

export interface RoutingConfig {
    version: number
    updatedAt: string
    flows: RoutingFlow[]
    activeFlowId?: string  // When set, all requests use this flow
    accountRouting?: AccountRoutingConfig
    disabledAccounts?: string[]  // "provider:accountId" 格式，手动禁用的账户
    modelMappings?: ModelMapping[]  // 🆕 模型映射配置
}

const ROUTING_FILE = join(getDataDir(), "routing.json")
const CURRENT_VERSION = 2

function ensureDir(): void {
    const dir = getDataDir()
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
    }
}

function normalizeEntry(entry: RoutingEntry): RoutingEntry | null {
    if (entry.provider === "codex" && isHiddenCodexModel(entry.modelId)) {
        return null
    }
    return {
        ...entry,
        id: entry.id || randomUUID(),
        label: entry.label || `${entry.provider}:${entry.modelId}`,
    }
}

function normalizeAccountEntry(entry: AccountRoutingEntry): AccountRoutingEntry {
    return {
        ...entry,
        id: entry.id || randomUUID(),
    }
}

function normalizeAccountRoute(route: Partial<AccountRoutingRoute>, index: number): AccountRoutingRoute | null {
    const modelId = (route.modelId || "").trim()
    if (modelId && isHiddenCodexModel(modelId)) {
        return null
    }
    const entries = Array.isArray(route.entries) ? route.entries.map(normalizeAccountEntry) : []

    return {
        id: route.id || randomUUID(),
        modelId,
        entries,
    }
}

function normalizeFlow(flow: Partial<RoutingFlow>, index: number): RoutingFlow {
    const name = (flow.name || `Flow ${index + 1}`).trim()
    const entries = Array.isArray(flow.entries)
        ? flow.entries.map(normalizeEntry).filter((entry): entry is RoutingEntry => !!entry)
        : []

    return {
        id: flow.id || randomUUID(),
        name: name || `Flow ${index + 1}`,
        entries,
    }
}

function normalizeConfig(raw: Partial<RoutingConfig> & { entries?: RoutingEntry[] }): RoutingConfig {
    const updatedAt = raw.updatedAt || new Date().toISOString()
    const accountRouting: AccountRoutingConfig = {
        smartSwitch: raw.accountRouting?.smartSwitch ?? false,
        routes: Array.isArray(raw.accountRouting?.routes)
            ? raw.accountRouting!.routes
                .map((route, index) => normalizeAccountRoute(route, index))
                .filter((route): route is AccountRoutingRoute => !!route)
            : [],
    }
    const disabledAccounts = Array.isArray(raw.disabledAccounts) ? raw.disabledAccounts : []
    
    // 🆕 处理模型映射
    const modelMappings: ModelMapping[] = Array.isArray(raw.modelMappings) 
        ? raw.modelMappings.map(m => ({
            id: m.id || randomUUID(),
            source: (m.source || "").trim().toLowerCase(),
            target: (m.target || "").trim(),
            enabled: m.enabled !== false,
        })).filter(m => m.source && m.target)
        : getDefaultModelMappings()

    if (Array.isArray(raw.flows)) {
        const flows = raw.flows.flatMap((flow, index) => {
            const rawEntries = Array.isArray(flow.entries) ? flow.entries : []
            const normalized = normalizeFlow(flow, index)
            if (rawEntries.length > 0 && normalized.entries.length === 0) {
                return []
            }
            return [normalized]
        })
        const activeFlowId = flows.some(flow => flow.id === raw.activeFlowId)
            ? raw.activeFlowId
            : undefined
        return {
            version: raw.version || CURRENT_VERSION,
            updatedAt,
            flows,
            activeFlowId,
            accountRouting,
            disabledAccounts,
            modelMappings,
        }
    }

    if (Array.isArray(raw.entries)) {
        const legacyEntries = raw.entries
            .map(normalizeEntry)
            .filter((entry): entry is RoutingEntry => !!entry)
        return {
            version: CURRENT_VERSION,
            updatedAt,
            flows: legacyEntries.length
                ? [{ id: randomUUID(), name: "default", entries: legacyEntries }]
                : [],
            accountRouting,
            disabledAccounts,
            modelMappings,
        }
    }

    return { version: CURRENT_VERSION, updatedAt, flows: [], accountRouting, disabledAccounts, modelMappings }
}

export function loadRoutingConfig(): RoutingConfig {
    try {
        if (!existsSync(ROUTING_FILE)) {
            return { 
                version: CURRENT_VERSION, 
                updatedAt: new Date().toISOString(), 
                flows: [], 
                accountRouting: { smartSwitch: false, routes: [] }, 
                disabledAccounts: [],
                modelMappings: getDefaultModelMappings(),
            }
        }
        const raw = JSON.parse(readFileSync(ROUTING_FILE, "utf-8")) as Partial<RoutingConfig> & {
            entries?: RoutingEntry[]
        }
        return normalizeConfig(raw)
    } catch (error) {
        consola.warn("Failed to load routing config:", error)
        return { 
            version: CURRENT_VERSION, 
            updatedAt: new Date().toISOString(), 
            flows: [], 
            accountRouting: { smartSwitch: false, routes: [] }, 
            disabledAccounts: [],
            modelMappings: getDefaultModelMappings(),
        }
    }
}

export function saveRoutingConfig(
    flows: RoutingFlow[],
    activeFlowId?: string,
    accountRouting?: AccountRoutingConfig,
    disabledAccounts?: string[],
    modelMappings?: ModelMapping[]
): RoutingConfig {
    ensureDir()
    // Preserve existing activeFlowId if not explicitly provided
    const existing = loadRoutingConfig()
    const config: RoutingConfig = {
        version: CURRENT_VERSION,
        updatedAt: new Date().toISOString(),
        flows: flows.map((flow, index) => normalizeFlow(flow, index)),
        activeFlowId: activeFlowId !== undefined ? activeFlowId : existing.activeFlowId,
        accountRouting: accountRouting !== undefined ? accountRouting : existing.accountRouting,
        disabledAccounts: disabledAccounts !== undefined ? disabledAccounts : existing.disabledAccounts,
        modelMappings: modelMappings !== undefined ? modelMappings : existing.modelMappings,
    }
    writeFileSync(ROUTING_FILE, JSON.stringify(config, null, 2))
    return config
}

// 检查账户是否被禁用
export function isAccountDisabled(provider: string, accountId: string): boolean {
    const config = loadRoutingConfig()
    const key = `${provider}:${accountId}`
    return config.disabledAccounts?.includes(key) ?? false
}

// 获取禁用账户列表
export function getDisabledAccounts(): string[] {
    const config = loadRoutingConfig()
    return config.disabledAccounts || []
}

// 切换账户禁用状态
export function toggleAccountDisabled(provider: string, accountId: string): { disabled: boolean; config: RoutingConfig } {
    const config = loadRoutingConfig()
    const key = `${provider}:${accountId}`
    const disabledAccounts = config.disabledAccounts || []

    const index = disabledAccounts.indexOf(key)
    if (index >= 0) {
        // 已禁用，移除禁用
        disabledAccounts.splice(index, 1)
    } else {
        // 未禁用，添加禁用
        disabledAccounts.push(key)
    }

    const newConfig = saveRoutingConfig(config.flows, config.activeFlowId, config.accountRouting, disabledAccounts)
    return { disabled: index < 0, config: newConfig }
}

export function setActiveFlow(flowId: string | null): RoutingConfig {
    const config = loadRoutingConfig()
    config.activeFlowId = flowId || undefined
    config.updatedAt = new Date().toISOString()
    writeFileSync(ROUTING_FILE, JSON.stringify(config, null, 2))
    return config
}

// ==================== 🆕 模型映射相关 ====================

/**
 * 预置的常见请求模型列表（用于 UI 下拉选择）
 */
export const PRESET_SOURCE_MODELS = [
    // Claude 系列（带日期后缀）
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-5-20251101",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-sonnet-20240620",
    "claude-3-haiku-20240307",
    "claude-haiku-4-5",
    "claude-haiku-4-5-thinking",
    "claude-sonnet-4-5",
    "claude-opus-4-5",
    
    // DeepSeek 系列
    "deepseek-chat",
    "deepseek-coder",
    "deepseek-v3",
    "deepseek-r1",
    
    // Kimi / Moonshot 系列
    "kimi-k1",
    "kimi-k1-5",
    "moonshot-v1-8k",
    "moonshot-v1-32k",
    "moonshot-v1-128k",
    
    // 通义千问
    "qwen-turbo",
    "qwen-plus",
    "qwen-max",
    "qwen-coder",
    
    // 文心一言
    "ernie-bot",
    "ernie-bot-4",
    "ernie-bot-turbo",
    
    // OpenAI 系列
    "gpt-4",
    "gpt-4-turbo",
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-3.5-turbo",
    
    // 其他
    "llama-3-70b",
    "llama-3.1-405b",
    "mistral-large",
    "mixtral-8x22b",
]

/**
 * 获取默认模型映射
 */
export function getDefaultModelMappings(): ModelMapping[] {
    return [
        // Claude Haiku 系列 → Gemini Flash
        { id: randomUUID(), source: "claude-haiku-4-5-20251001", target: "gemini-2.5-flash", enabled: true },
        { id: randomUUID(), source: "claude-haiku-4-5", target: "gemini-2.5-flash", enabled: true },
        { id: randomUUID(), source: "claude-haiku-4-5-thinking", target: "gemini-2.5-flash-thinking", enabled: true },
        { id: randomUUID(), source: "claude-3-haiku-20240307", target: "gemini-2.5-flash", enabled: true },
        
        // Claude Sonnet 带日期 → 标准名
        { id: randomUUID(), source: "claude-sonnet-4-5-20250929", target: "claude-sonnet-4-5-thinking", enabled: true },
        { id: randomUUID(), source: "claude-3-5-sonnet-20241022", target: "claude-sonnet-4-5", enabled: true },
        { id: randomUUID(), source: "claude-3-5-sonnet-20240620", target: "claude-sonnet-4-5", enabled: true },
        
        // Claude Opus 带日期 → 标准名
        { id: randomUUID(), source: "claude-opus-4-5-20251101", target: "claude-opus-4-5-thinking", enabled: true },
        
        // DeepSeek → Gemini
        { id: randomUUID(), source: "deepseek-chat", target: "gemini-2.5-flash", enabled: true },
        { id: randomUUID(), source: "deepseek-v3", target: "gemini-2.5-pro", enabled: true },
        { id: randomUUID(), source: "deepseek-r1", target: "gemini-2.5-flash-thinking", enabled: true },
        
        // GPT → Claude/Gemini
        { id: randomUUID(), source: "gpt-4o", target: "claude-sonnet-4-5", enabled: true },
        { id: randomUUID(), source: "gpt-4o-mini", target: "gemini-2.5-flash", enabled: true },
        { id: randomUUID(), source: "gpt-4-turbo", target: "claude-sonnet-4-5", enabled: true },
        { id: randomUUID(), source: "gpt-3.5-turbo", target: "gemini-2.5-flash", enabled: true },
    ]
}

/**
 * 根据模型映射配置解析请求的模型名
 * @param requestModel 请求的模型名
 * @returns { model: 实际使用的模型, mapped: 是否经过映射, originalModel?: 原始请求模型 }
 */
export function resolveModelMapping(requestModel: string): { model: string; mapped: boolean; originalModel?: string } {
    const config = loadRoutingConfig()
    const mappings = config.modelMappings || []
    
    // 不区分大小写匹配
    const lowerRequest = requestModel.toLowerCase()
    const mapping = mappings.find(m => m.enabled && m.source.toLowerCase() === lowerRequest)
    
    if (mapping) {
        return { model: mapping.target, mapped: true, originalModel: requestModel }
    }
    
    return { model: requestModel, mapped: false }
}

/**
 * 保存模型映射配置
 */
export function saveModelMappings(mappings: ModelMapping[]): RoutingConfig {
    const config = loadRoutingConfig()
    return saveRoutingConfig(
        config.flows, 
        config.activeFlowId, 
        config.accountRouting, 
        config.disabledAccounts,
        mappings.map(m => ({
            id: m.id || randomUUID(),
            source: m.source.trim().toLowerCase(),
            target: m.target.trim(),
            enabled: m.enabled !== false,
        }))
    )
}

/**
 * 获取模型映射配置
 */
export function getModelMappings(): ModelMapping[] {
    const config = loadRoutingConfig()
    return config.modelMappings || getDefaultModelMappings()
}
