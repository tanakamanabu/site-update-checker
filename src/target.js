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
];

export async function resolveTarget(name) {
  const config = await loadConfig();
  const targets = config.targets ?? [];

  if (targets.length === 0) {
    console.error("❌ config.js に targets が定義されていません。");
    process.exit(1);
  }

  let target;
  if (name) {
    target = targets.find((t) => t.name === name);
    if (!target) {
      console.error(`❌ 対象 "${name}" が見つかりません。`);
      console.error(`   利用可能: ${targets.map((t) => t.name).join(", ")}`);
      process.exit(1);
    }
  } else if (targets.length === 1) {
    target = targets[0];
  } else {
    console.error("❌ 対象名を指定してください（targets が複数あります）。");
    console.error(`   利用可能: ${targets.map((t) => t.name).join(", ")}`);
    console.error(`   例: npm run before -- ${targets[0].name}`);
    process.exit(1);
  }

  if (!target.baseUrl) {
    console.error(`❌ 対象 "${target.name}" に baseUrl が設定されていません。`);
    process.exit(1);
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
