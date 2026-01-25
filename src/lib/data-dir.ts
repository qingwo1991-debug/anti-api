import { existsSync, mkdirSync } from "fs"
import { homedir } from "os"
import { join } from "path"

export function getDataDir(): string {
    const override = process.env.ANTI_API_DATA_DIR
    if (override && override.trim()) {
        return override
    }
    const home = process.env.HOME || process.env.USERPROFILE || homedir()
    return join(home, ".anti-api")
}

export function ensureDataDir(): string {
    const dir = getDataDir()
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
    }
    return dir
}

export function getLegacyProjectDataDir(): string {
    return join(process.cwd(), "data")
}
