// 导出文件一律经这里写。解析时已经把认得出的密钥删掉了，这里在落盘前再查一遍：
// 数据里任何一段文字还能被 redact 改动，或者整份文本里还有私钥块、固定前缀的令牌、打过码的密钥片段，
// 就不写这个文件，整次导出报错停下。报错只说文件名和处数，不打印内容
import fs from 'node:fs';
import path from 'node:path';
import { countSecrets, textHasSecret } from './parse.mjs';

export class SecretLeftError extends Error {}

export function checkData(data, label) {
  const n = countSecrets(data);
  if (n) throw new SecretLeftError(`${label} 的数据里还有 ${n} 段像密钥的文字，没有写入任何文件`);
}

export function writeExport(file, text) {
  if (textHasSecret(text)) throw new SecretLeftError(`${path.basename(file)} 里还有像密钥的内容，没有写入`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
