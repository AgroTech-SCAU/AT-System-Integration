// 安装到仓库 .install，不依赖 gui/node_modules 作为启动入口
const fs = require('node:fs')
const path = require('node:path')
const target = process.argv[2]
if (!target) throw new Error('缺少桌面安装目录')
fs.mkdirSync(target, { recursive: true })
const runtime = path.join(path.dirname(require.resolve('electron/package.json')), 'dist')
fs.cpSync(runtime, path.join(target, 'runtime'), { recursive: true })
for (const name of ['main.cjs', 'preload.cjs']) fs.copyFileSync(path.join(__dirname, name), path.join(target, name))
fs.copyFileSync(path.join(__dirname, '../THIRD_PARTY_NOTICES.md'), path.join(target, 'THIRD_PARTY_NOTICES.md'))
console.log(`Electron 桌面环境已安装: ${target}`)
