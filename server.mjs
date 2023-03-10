
import 'colors'
import { createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import { hkdfSync, randomBytes } from 'node:crypto'
import WebSocket, { WebSocketServer } from 'ws'
import { AEAD } from './aead.mjs'
import {
  getEnv, debuglog, infolog, warnlog, errorlog,
  EVP_BytesToKey, connect, inet_ntoa, inet_ntop
} from './util.mjs'

const CLOSED  = 'closed'
const OPENING = 'opening'
const OPEN    = 'open'
const WRITING = 'writing'

const dump = (from, to, stage) => `from=${from.blue} to=${to.cyan} stage=${stage.green}`

const METHOD = getEnv('METHOD', 'chacha20-poly1305', [
  'aes-256-gcm',
  'chacha20-poly1305'
])
const PASS   = getEnv('PASS', 'secret')
const PORT   = getEnv('PORT', 80)

const { keySize: KEY_SIZE, saltSize: SALT_SIZE, tagSize: TAG_SIZE } = AEAD.getSize(METHOD)
const { key: KEY } = EVP_BytesToKey(PASS, KEY_SIZE)

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`)
  switch (pathname) {
    case '/':
    case '/index.html':
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html')
      createReadStream('./index.html').pipe(res)
      break

    case '/generate_204':
      res.statusCode = 204
      res.setHeader('Connection', 'close')
      res.end()
      break

    default:
      res.statusCode = 404
      res.setHeader('Content-Type', 'text/html')
      createReadStream('./404.html').pipe(res)
      break
  }
  warnlog(`request: method='${req.method}' url='${req.url}' user-agent='${req.headers['user-agent']}'`)
})

const wss = new WebSocketServer({ server })

wss.on('connection', (ws, req) => {
  // decryption context
  let rx = [] // received bytes waiting to be decrypted
  let decipher = null
  let cipherTextSize = 2
  let chunkIndex = 0
  const payloads = []

  // encryption context
  let tx = [] // encrypted chunks waiting to be sent
  let cipher = null

  // server context
  let stage = CLOSED
  const from = `${req.socket.remoteAddress}:${req.socket.remotePort}` // client address
  let to = 'unknown' // target address
  let remote = null // target socket

  debuglog(`client connected: ${from}`)

  ws.on('message', async (data) => {
    // retrieve bytes received last time
    if (rx.length > 0) {
      rx.push(data)
      data = Buffer.concat(rx)
      rx = []
    }

    // init decipher
    if (decipher === null) {
      if (data.length < SALT_SIZE) {
        rx.push(data)
        debuglog('more bytes needed')
        return
      }

      const salt = Buffer.alloc(SALT_SIZE)
      data.copy(salt, 0, 0, SALT_SIZE)
      data = data.subarray(SALT_SIZE)

      const dk = hkdfSync('sha1', KEY, salt, 'ss-subkey', KEY_SIZE)
      decipher = new AEAD(METHOD, dk)
      debuglog('decipher initialized')
    }

    // decrypt chunks
    while (data.length > 0) {
      const chunkSize = cipherTextSize + TAG_SIZE
      if (data.length < chunkSize) {
        rx.push(data)
        debuglog('more bytes needed')
        break
      }

      const chunk = data.subarray(0, chunkSize)
      data = data.subarray(chunkSize)

      const cipherText = chunk.subarray(0, cipherTextSize)
      const authTag = chunk.subarray(cipherTextSize)
      const plainText = decipher.decrypt(cipherText, authTag)

      if (plainText === null) {
        warnlog('invalid password or cipher', dump(from, to, stage))
        ws.terminate() // 'close' event will be called
        return
      }

      if (chunkIndex % 2 === 0) { // current chunk is length chunk
        cipherTextSize = plainText.readUInt16BE(0)
      } else { // current chunk is payload chunk
        cipherTextSize = 2
        payloads.push(plainText)
        debuglog(`payload decrypted: ${plainText.length} bytes`)
      }
      chunkIndex++
    }
    data = null

    // consume payloads
    if (payloads.length === 0) {
      return
    }
    if (stage === OPENING || stage === WRITING) {
      return
    }
    if (stage === CLOSED) {
      stage = OPENING

      let addr, port
      let address = payloads.shift()
      switch (address[0]) {
        case 3: // Domain
          addr = address.subarray(2, 2 + address[1]).toString('binary')
          port = address.readUInt16BE(2 + address[1])
          address = address.subarray(4 + address[1])
          break
        case 1: // IPv4
          addr = inet_ntoa(address.subarray(1, 5))
          port = address.readUInt16BE(5)
          address = address.subarray(7)
          break
        case 4: // IPv6
          addr = inet_ntop(address.subarray(1, 17))
          port = address.readUInt16BE(17)
          address = address.subarray(19)
          break
        default:
          warnlog('invalid atyp', dump(from, to, stage))
          ws.terminate()
          return
      }
      if (address.length !== 0) {
        payloads.push(address)
      }
      to = `${addr}:${port}`
      debuglog(`remote address parsed: ${to}`)

      try {
        ws.pause()
        remote = await connect(port, addr)
        ws.resume()
      } catch (err) {
        errorlog(err.message, dump(from, to, stage))
        ws.terminate()
        return
      }
      debuglog('remote connected')

      if (ws.readyState !== WebSocket.OPEN) {
        remote.destroy()
        return
      }

      const salt = randomBytes(SALT_SIZE)
      tx.push(salt)
      const dk = hkdfSync('sha1', KEY, salt, 'ss-subkey', KEY_SIZE)
      cipher = new AEAD(METHOD, dk)
      debuglog('cipher initialized')

      remote.on('data', (data) => {
        debuglog('reply received')
        while (data.length > 0) {
          const payload = data.subarray(0, 0x3fff)
          const length = Buffer.alloc(2)
          length.writeUInt16BE(payload.length)
          tx.push(cipher.encrypt(length))
          tx.push(cipher.encrypt(payload))
          data = data.subarray(0x3fff)
        }
        data = null

        remote.pause()
        ws.send(Buffer.concat(tx), () => remote.resume())
        tx = []
      })

      // 'close' event will be called
      remote.on('error', (err) => errorlog(err.message, dump(from, to, stage)))
      remote.on('end', () => remote.end())
      remote.on('close', () => {
        debuglog('remote disconnected')
        if (ws.readyState === WebSocket.OPEN) ws.terminate()
      })
    }

    stage = WRITING
    while (payloads.length !== 0) {
      if (remote.write(payloads.shift()) === false) {
        ws.pause()
        await new Promise(resolve => remote.once('drain', resolve))
        ws.resume()
      }
      debuglog('payload sent')
    }
    stage = OPEN
  })

  ws.on('close', () => {
    debuglog('client disconnected')
    if (remote !== null && !remote.destroyed) remote.destroy()
    decipher = cipher = rx = tx = null
  })
})

server.listen(PORT, () => infolog(`server running at http://0.0.0.0:${PORT}/`))
