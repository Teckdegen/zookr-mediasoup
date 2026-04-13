import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import * as mediasoup from 'mediasoup'
import type { Worker, Router, WebRtcTransport, Producer, Consumer } from 'mediasoup/node/lib/types'

const app = express()
app.use(cors())
app.use(express.json())

const httpServer = createServer(app)
const wss = new WebSocketServer({ server: httpServer })

// ─── Mediasoup config ────────────────────────────────────────────────────────

const MEDIA_CODECS: mediasoup.types.RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 100,
    rtcpFeedback: [],
    parameters: {},
  },
]

const WEBRTC_TRANSPORT_OPTIONS: mediasoup.types.WebRtcTransportOptions = {
  listenIps: [
    {
      ip: '0.0.0.0',
      announcedIp: process.env.ANNOUNCED_IP || '127.0.0.1',
    },
  ],
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
}

// ─── State ───────────────────────────────────────────────────────────────────

let worker: Worker
const routers = new Map<string, Router>()           // roomId → Router
const peers = new Map<string, PeerState>()           // peerId → PeerState
const roomPeers = new Map<string, Set<string>>()     // roomId → Set<peerId>
const wsClients = new Map<string, WebSocket>()       // peerId → WebSocket

interface PeerState {
  peerId: string
  roomId: string
  userId: string
  sendTransport?: WebRtcTransport
  recvTransport?: WebRtcTransport
  producers: Map<string, Producer>
  consumers: Map<string, Consumer>
}

// ─── Worker init ─────────────────────────────────────────────────────────────

async function createWorker() {
  worker = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
  })

  worker.on('died', () => {
    console.error('mediasoup worker died, exiting...')
    process.exit(1)
  })

  console.log('mediasoup worker created')
}

async function getOrCreateRouter(roomId: string): Promise<Router> {
  if (routers.has(roomId)) return routers.get(roomId)!

  const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS })
  routers.set(roomId, router)
  return router
}

// ─── WebSocket signaling ──────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const url = new URL(req.url!, `http://${req.headers.host}`)
  const pathParts = url.pathname.split('/')
  const roomId = pathParts[2]
  const userId = url.searchParams.get('userId') || 'unknown'
  const peerId = `${userId}_${Date.now()}`

  console.log(`Peer connected: ${peerId} → room ${roomId}`)

  wsClients.set(peerId, ws)

  // Init peer state
  peers.set(peerId, {
    peerId,
    roomId,
    userId,
    producers: new Map(),
    consumers: new Map(),
  })

  // Add to room
  if (!roomPeers.has(roomId)) roomPeers.set(roomId, new Set())
  const room = roomPeers.get(roomId)!
  room.add(peerId)

  // Notify existing peers
  room.forEach((pid) => {
    if (pid !== peerId) {
      send(pid, { type: 'peer_joined', peerId })
    }
  })

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString())
      await handleMessage(peerId, roomId, msg)
    } catch (e) {
      console.error('WS message error:', e)
    }
  })

  ws.on('close', () => {
    cleanup(peerId, roomId)
  })

  ws.on('error', (e) => console.error('WS error:', e))

  // Send router RTP capabilities to new peer
  getOrCreateRouter(roomId).then((router) => {
    send(peerId, { type: 'router_rtp_capabilities', rtpCapabilities: router.rtpCapabilities })
  })
})

async function handleMessage(peerId: string, roomId: string, msg: any) {
  const router = await getOrCreateRouter(roomId)
  const peer = peers.get(peerId)
  if (!peer) return

  switch (msg.type) {
    case 'create_send_transport': {
      const transport = await router.createWebRtcTransport(WEBRTC_TRANSPORT_OPTIONS)
      peer.sendTransport = transport

      transport.on('dtlsstatechange', (state) => {
        if (state === 'closed') transport.close()
      })

      send(peerId, {
        type: 'send_transport_created',
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      })
      break
    }

    case 'create_recv_transport': {
      const transport = await router.createWebRtcTransport(WEBRTC_TRANSPORT_OPTIONS)
      peer.recvTransport = transport

      transport.on('dtlsstatechange', (state) => {
        if (state === 'closed') transport.close()
      })

      send(peerId, {
        type: 'recv_transport_created',
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      })
      break
    }

    case 'connect_transport': {
      const transport = msg.direction === 'send' ? peer.sendTransport : peer.recvTransport
      if (transport) await transport.connect({ dtlsParameters: msg.dtlsParameters })
      send(peerId, { type: 'transport_connected', direction: msg.direction })
      break
    }

    case 'produce': {
      if (!peer.sendTransport) break
      const producer = await peer.sendTransport.produce({
        kind: msg.kind,
        rtpParameters: msg.rtpParameters,
      })

      peer.producers.set(producer.id, producer)

      producer.on('transportclose', () => {
        peer.producers.delete(producer.id)
      })

      send(peerId, { type: 'produced', producerId: producer.id })

      // Notify other peers to consume this new producer
      const room = roomPeers.get(roomId)!
      room.forEach((pid) => {
        if (pid !== peerId) {
          send(pid, {
            type: 'new_producer',
            producerId: producer.id,
            producerPeerId: peerId,
          })
        }
      })
      break
    }

    case 'consume': {
      if (!peer.recvTransport) break
      const producer = findProducer(msg.producerId, roomId, peerId)
      if (!producer) break

      if (!router.canConsume({ producerId: producer.id, rtpCapabilities: msg.rtpCapabilities })) break

      const consumer = await peer.recvTransport.consume({
        producerId: producer.id,
        rtpCapabilities: msg.rtpCapabilities,
        paused: false,
      })

      peer.consumers.set(consumer.id, consumer)

      consumer.on('transportclose', () => peer.consumers.delete(consumer.id))
      consumer.on('producerclose', () => {
        peer.consumers.delete(consumer.id)
        send(peerId, { type: 'consumer_closed', consumerId: consumer.id })
      })

      send(peerId, {
        type: 'consumed',
        consumerId: consumer.id,
        producerId: producer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      })
      break
    }

    default:
      console.log('Unknown message type:', msg.type)
  }
}

function findProducer(producerId: string, roomId: string, excludePeerId: string): Producer | null {
  const room = roomPeers.get(roomId)
  if (!room) return null

  for (const pid of room) {
    if (pid === excludePeerId) continue
    const peer = peers.get(pid)
    if (!peer) continue
    const producer = peer.producers.get(producerId)
    if (producer) return producer
  }
  return null
}

function cleanup(peerId: string, roomId: string) {
  const peer = peers.get(peerId)
  if (peer) {
    peer.producers.forEach((p) => p.close())
    peer.consumers.forEach((c) => c.close())
    peer.sendTransport?.close()
    peer.recvTransport?.close()
  }

  peers.delete(peerId)
  wsClients.delete(peerId)

  const room = roomPeers.get(roomId)
  if (room) {
    room.delete(peerId)
    if (room.size === 0) {
      roomPeers.delete(roomId)
      routers.get(roomId)?.close()
      routers.delete(roomId)
    } else {
      room.forEach((pid) => send(pid, { type: 'peer_left', peerId }))
    }
  }

  console.log(`Peer disconnected: ${peerId}`)
}

function send(peerId: string, msg: object) {
  const ws = wsClients.get(peerId)
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ status: 'ok', rooms: routers.size, peers: peers.size }))

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3001')

createWorker().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`ZOOKR mediasoup SFU running on port ${PORT}`)
  })
})
