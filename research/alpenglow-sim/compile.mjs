// Compiles contracts/AlpenglowSim.sol into out/AlpenglowSim.json.
import fs from 'node:fs'
import solc from 'solc'

const source = fs.readFileSync(new URL('./contracts/AlpenglowSim.sol', import.meta.url), 'utf8')
const input = {
  language: 'Solidity',
  sources: { 'AlpenglowSim.sol': { content: source } },
  settings: {
    evmVersion: 'cancun',
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
}
const out = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (out.errors ?? []).filter((e) => e.severity === 'error')
for (const e of out.errors ?? []) console.error(e.formattedMessage)
if (errors.length) process.exit(1)
const contracts = {}
for (const [name, c] of Object.entries(out.contracts['AlpenglowSim.sol'])) {
  contracts[name] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }
}
fs.mkdirSync(new URL('./out/', import.meta.url), { recursive: true })
fs.writeFileSync(new URL('./out/AlpenglowSim.json', import.meta.url), JSON.stringify(contracts))
console.log('compiled:', Object.keys(contracts).join(', '))
