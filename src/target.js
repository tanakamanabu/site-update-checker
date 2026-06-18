/**
 * target.js
 * config.js の targets[] から実行対象を解決し、
 * 共通設定とマージした「解決済み設定」を返す。
 *
 * 実行時引数で対象名を指定する:
 *   node src/crawl.js before <name>
 * 対象が1つだけなら name 省略可。複数ある場合は name 必須。
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// config.js は .gitignore 済みで存在しないことがある。静的 import だと
// 「モジュールが見つからない」という分かりにくいエラーで落ちるので、
// 動的 import して不在時はセットアップ手順を案内する。
async function loadConfig() {
  const configPath = fileURLToPath(new URL("../config.js", import.meta.url));
  if (!fs.existsSync(configPath)) {
    console.error("❌ config.js が見つかりません。");
    console.error("   初回セットアップ: cp config.sample.js config.js");
    console.error("   その後 config.js の baseUrl を対象サイトに書き換えてください。");
    process.exit(1);
  }
  const mod = await import(new URL("../config.js", import.meta.url));
  return mod.config;
}

// 共通設定として扱うキー（targets[] 側で同名キーがあれば上書きされる）
const SHARED_KEYS = [
  "concurrency",
  "timeout",
  "diffThreshold",
  "viewport",
  "excludePatterns",
  "stayOnDomain",
  "userAgent",
  "disableAnimations",
  "screenshotDelay",
  "blockResources",
  "checkExternalLinks",
  "linkCheckTimeout",
];

/**
 * 設定オブジェクトと対象名から「解決済み設定」を組み立てる純粋関数。
 * I/O・process.exit を持たず、問題があれば Error を throw する
 * （CLI 側の resolveTarget が catch してメッセージ表示＋exit する）。
 * これにより config.js の有無に依らずユニットテストできる。
 */
export function resolveTargetConfig(config, name) {
  const targets = config.targets ?? [];

  if (targets.length === 0) {
    throw new Error("config.js に targets が定義されていません。");
  }

  let target;
  if (name) {
    target = targets.find((t) => t.name === name);
    if (!target) {
      throw new Error(
        `対象 "${name}" が見つかりません。利用可能: ${targets.map((t) => t.name).join(", ")}`
      );
    }
  } else if (targets.length === 1) {
    target = targets[0];
  } else {
    throw new Error(
      `対象名を指定してください（targets が複数あります）。利用可能: ${targets
        .map((t) => t.name)
        .join(", ")}`
    );
  }

  if (!target.baseUrl) {
    throw new Error(`対象 "${target.name}" に baseUrl が設定されていません。`);
  }

  // 共通設定 → 対象固有設定 の順でマージ（対象側が優先）
  const merged = { basicAuth: null };
  for (const key of SHARED_KEYS) {
    if (config[key] !== undefined) merged[key] = config[key];
  }
  Object.assign(merged, target);

  // 対象名でレポート出力先を分離: reports/<name>/
  merged.reportDir = path.join(config.reportDir ?? "./reports", target.name);

  return merged;
}

// CLI 用ラッパー: config.js を読み込み、解決に失敗したら案内して終了する。
export async function resolveTarget(name) {
  const config = await loadConfig();
  try {
    return resolveTargetConfig(config, name);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
