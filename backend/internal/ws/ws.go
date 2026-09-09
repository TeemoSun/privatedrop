package ws

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	writeWait      = 5 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 512 * 1024
	sendBufferSize = 64
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type client struct {
	manager  *ConnectionManager
	conn     *websocket.Conn
	deviceID uuid.UUID
	send     chan []byte
}

type ConnectionManager struct {
	mu      sync.RWMutex
	clients map[*client]bool
}

func NewConnectionManager() *ConnectionManager {
	return &ConnectionManager{
		clients: make(map[*client]bool),
	}
}

func (m *ConnectionManager) register(c *client) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.clients[c] = true
}

func (m *ConnectionManager) unregister(c *client) {
	m.mu.Lock()
	if _, ok := m.clients[c]; ok {
		delete(m.clients, c)
		close(c.send)
	}
	m.mu.Unlock()
}

func (m *ConnectionManager) Broadcast(event interface{}) {
	data, err := json.Marshal(event)
	if err != nil {
		return
	}

	m.mu.RLock()
	defer m.mu.RUnlock()

	for c := range m.clients {
		select {
		case c.send <- data:
		default:
			// Buffer full, drop or let writePump handle it
		}
	}
}

func CloseUnauthorized(w http.ResponseWriter, r *http.Request) error {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return err
	}
	defer conn.Close()

	cm := websocket.FormatCloseMessage(4401, "invalid token")
	_ = conn.WriteControl(websocket.CloseMessage, cm, time.Now().Add(writeWait))
	// Brief pause to allow the TCP stack to flush close frame before close
	time.Sleep(10 * time.Millisecond)
	return nil
}

func (m *ConnectionManager) HandleConnection(w http.ResponseWriter, r *http.Request, deviceID uuid.UUID) error {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return err
	}

	c := &client{
		manager:  m,
		conn:     conn,
		deviceID: deviceID,
		send:     make(chan []byte, sendBufferSize),
	}

	m.register(c)

	go c.writePump()
	c.readPump()
	return nil
}

func (c *client) readPump() {
	defer func() {
		c.manager.unregister(c)
		_ = c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		messageType, message, err := c.conn.ReadMessage()
		if err != nil {
			break
		}
		// Reset read deadline on every incoming client message
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))

		if messageType == websocket.TextMessage && string(message) == "ping" {
			select {
			case c.send <- []byte("pong"):
			default:
			}
		}
	}
}

func (c *client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			_, _ = w.Write(message)
			if err := w.Close(); err != nil {
				return
			}

		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
