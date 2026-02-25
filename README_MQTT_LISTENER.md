# MQTT Listener — Modular, Production-Grade MFC System

Complete modular solution for MQTT telemetry validation, real-time Socket.io emissions, and OGC SensorThings-compliant database persistence.

## Quick Start

### 1. Install Dependencies
```bash
npm install mqtt socket.io mongoose express
```

### 2. Set Environment Variables
```bash
export MQTT_BROKER_URL=mqtt://test.mosquitto.org
export MONGODB_URI=mongodb://localhost:27017/mfc-system
```

### 3. Wire into Your Server

```javascript
const { Server } = require('socket.io');
const http = require('http');
const initMqttListener = require('./mqttListener');
const Observation = require('./models/Observation');

const httpServer = http.createServer();
const io = new Server(httpServer);

// Initialize the listener — pass Socket.io and Mongoose model
const mqttClient = initMqttListener(io, Observation);

httpServer.listen(3000);
```

---

## Module Architecture

### 1. **validations/telemetryValidator.js** — Pure Validation Logic

Zero dependencies. All validation rules in one place.

```javascript
const { validateTelemetry } = require('./validations/telemetryValidator');

const payload = {
  ph: 7.1,
  turbidity: 12.0,
  voltage: 0.4,
  timestamp: new Date().toISOString(),
};

const result = validateTelemetry(payload);
if (result.valid) {
  console.log('Date:', result.date); // Parsed Date object
} else {
  console.log('Rejected:', result.reason);
}
```

**Validation Rules (in order):**
1. **Integrity** — Object shape, required fields, numeric types
2. **Latency** — Packet not older than 5000ms and not in the future
3. **Physics** — Values within physically possible bounds

**Exports:**
- `validateTelemetry(payload)` → `{ valid: true, date: Date } | { valid: false, reason: string }`
- `getRequiredFields()` → `['ph', 'turbidity', 'voltage']`
- `getPhysicsBounds()` → `{ ph: {min, max}, ... }`
- `MAX_LATENCY_MS` → `5000`

---

### 2. **persistence/observationPersistence.js** — OGC Database Mapping

Maps sensor readings to OGC SensorThings Observations. One observation per sensor.

```javascript
const observationPersistence = require('./persistence/observationPersistence');

// Override the datastream map for testing
observationPersistence.setDatastreamMap({
  ph:        mongoose.Types.ObjectId('...'),
  turbidity: mongoose.Types.ObjectId('...'),
  voltage:   mongoose.Types.ObjectId('...'),
});

// Persist a validated payload
await observationPersistence.persistObservations(
  Observation,                           // Mongoose model
  { ph: 7.1, turbidity: 12, voltage: 0.4, timestamp: '...' },
  new Date(),                            // phenomenonTime
  ['ph', 'turbidity', 'voltage']         // sensor keys
);
```

**Result in MongoDB:**
```json
[
  { "datastream": ObjectId("..."), "phenomenonTime": ISODate("..."), "result": 7.1, "resultQuality": "VALID" },
  { "datastream": ObjectId("..."), "phenomenonTime": ISODate("..."), "result": 12, "resultQuality": "VALID" },
  { "datastream": ObjectId("..."), "phenomenonTime": ISODate("..."), "result": 0.4, "resultQuality": "VALID" }
]
```

**Exports:**
- `persistObservations(Observation, payload, phenomenonTime, sensorKeys)` → Promise
- `setDatastreamMap(map)` → void (for testing)
- `getDatastreamMap()` → object

---

### 3. **mqttListener.js** — Orchestrator & MQTT Connection

Ties together validation, persistence, and Socket.io emissions. Handles all connection lifecycle.

```javascript
const initMqttListener = require('./mqttListener');

const mqttClient = initMqttListener(io, Observation);
```

**What happens under the hood:**

1. **Topic: `mfc/system_01/telemetry`** (JSON)
   - Parse JSON
   - Validate (integrity → latency → physics)
   - **If invalid:** log and drop
   - **If valid:**
     - Emit to frontend: `io.emit('live_telemetry', payload)` (immediate)
     - Persist to DB (async, non-blocking)

2. **Topic: `mfc/system_01/alerts`** (JSON)
   - Parse JSON
   - Bypass validation
   - Emit directly: `io.emit('system_alert', payload)`

**Connection Lifecycle:**
- Auto-reconnect on disconnect (5s backoff)
- Graceful shutdown on SIGINT/SIGTERM
- Detailed console logging for all events

---

## Configuration

### Environment Variables
```bash
MQTT_BROKER_URL=mqtt://test.mosquitto.org    # Defaults to test.mosquitto.org
MONGODB_URI=mongodb://localhost:27017/mfc     # Mongoose default URI
```

### Sensor Bounds (Physics Constraints)
Edit `validations/telemetryValidator.js`:
```javascript
const PHYSICS_BOUNDS = {
  ph:        { min: 0,     max: 14       },
  turbidity: { min: 0,     max: Infinity },
  voltage:   { min: -50,   max: 50       }, // ← Adjust MFC range here
};
```

### Datastreams (OGC Mapping)
Edit `persistence/observationPersistence.js`:
```javascript
let DATASTREAMS = {
  ph:        new mongoose.Types.ObjectId('60d5ec49f4a3b200156f9abc'), // ← Update with real IDs
  turbidity: new mongoose.Types.ObjectId('60d5eb49f4a3b200156f9abd'),
  voltage:   new mongoose.Types.ObjectId('60d5ea49f4a3b200156f9abe'),
};
```

---

## Frontend Integration (via Socket.io)

### Live Telemetry
```javascript
socket.on('live_telemetry', (payload) => {
  console.log('Fresh sensor reading:', payload);
  // payload: { ph: 7.1, turbidity: 12, voltage: 0.4, timestamp: '...', ... }
});
```

### System Alerts
```javascript
socket.on('system_alert', (alert) => {
  console.error('MFC Alert:', alert);
  // alert: { message: 'System offline', timestamp: '...', ... }
});
```

---

## Testing

### Unit Test: Validator (Pure Function)

```bash
npm test tests/validations/telemetryValidator.test.js
```

Run with no mocks or setup. All test cases in `tests/validations/telemetryValidator.test.js`.

**Example tests:**
- Invalid payloads (null, array, missing fields)
- Non-numeric field values
- Out-of-bounds values
- Stale timestamps (>5s old)
- Future timestamps (>5s in the future)
- Valid payloads

### Integration Test Template (Persistence)

```javascript
const Observation = require('../models/Observation');
const observationPersistence = require('../persistence/observationPersistence');

describe('observationPersistence', () => {
  it('should map and insert observations', async () => {
    // Mock Observation.insertMany
    const mockInserted = [];
    Observation.insertMany = async (docs) => {
      mockInserted.push(...docs);
      return docs;
    };

    const payload = { ph: 7.1, turbidity: 12, voltage: 0.4 };
    const date = new Date();

    await observationPersistence.persistObservations(
      Observation,
      payload,
      date,
      ['ph', 'turbidity', 'voltage']
    );

    assert.strictEqual(mockInserted.length, 3);
    assert.strictEqual(mockInserted[0].result, 7.1);
  });
});
```

---

## Error Handling & Logging

Every module logs to console with a prefix tag:

```
[mqttListener]                  ← Main orchestrator events
[telemetryValidator]           ← Validation logs (if added)
[observationPersistence]       ← DB persistence logs
```

**Example output:**
```
[mqttListener] Connected to broker: mqtt://test.mosquitto.org
[mqttListener] Subscribed to "mfc/system_01/telemetry" (QoS 1)
[mqttListener] Live telemetry emitted
[observationPersistence] Persisted 3 Observation(s) { timestamp: '...', sensorCount: 3 }

[mqttListener] [DROP] Telemetry packet rejected {
  reason: "Field 'ph' value 99 is outside bounds [0, 14]",
  timestamp: "2025-02-24T...",
  deviceId: "esp32_01"
}
```

---

## Data Flow Diagram

```
┌──────────────────────────┐
│   MQTT Broker            │
│  (test.mosquitto.org)    │
└──────────────────────────┘
          │
          ├─ mfc/system_01/telemetry  ──┐
          │                             │
          └─ mfc/system_01/alerts  ────┐│
                                       ││
                    ┌──────────────────┘│
                    │                   │
              ┌─────▼────────────────────▼──────┐
              │   mqttListener.js                │
              │   (Main Orchestrator)            │
              └─────┬────────────────────────────┘
                    │
        ┌───────────┼───────────┐
        │           │           │
        ▼           ▼           ▼
    [VALIDATE]  [EMIT]      [PERSIST]
        │           │           │
        ▼           ▼           ▼
    Validator   Socket.io    MongoDB
    (pure)      (frontend)   (OGC)
```

---

## Production Checklist

- [ ] Replace `DATASTREAMS` ObjectIds with real Datastream `_id` values
- [ ] Adjust `PHYSICS_BOUNDS` to match your MFC cell specifications
- [ ] Set `MQTT_BROKER_URL` env var (or use your own broker)
- [ ] Configure MongoDB connection (`MONGODB_URI` env var)
- [ ] Ensure `Observation` model exists at `./models/Observation`
- [ ] Run unit tests: `npm test`
- [ ] Test with a real MQTT client: `mosquitto_pub -h test.mosquitto.org -t mfc/system_01/telemetry -m '{"ph":7.1,"turbidity":12,"voltage":0.4,"timestamp":"..."}'`
- [ ] Monitor logs in production (structured logging recommended)

---

## Extending the System

### Add a New Sensor
1. Add to `PHYSICS_BOUNDS` in `telemetryValidator.js`:
   ```javascript
   temperature: { min: -273.15, max: 500 }
   ```

2. Add to `REQUIRED_FIELDS` (or keep flexible by reading from payload keys)

3. Add to `DATASTREAMS` in `observationPersistence.js`:
   ```javascript
   temperature: new mongoose.Types.ObjectId('...')
   ```

4. Ensure your ESP32 sends it in the telemetry JSON

### Change Latency Window
Edit `MAX_LATENCY_MS` in `telemetryValidator.js`:
```javascript
const MAX_LATENCY_MS = 10_000; // 10 seconds
```

### Custom Validation Rules
Add a new function to `telemetryValidator.js`:
```javascript
function validateCustomRule(payload) {
  if (payload.ph > payload.voltage * 10) { // example: cross-field validation
    return 'pH cannot exceed voltage * 10';
  }
  return null;
}
```

Then integrate into `validateTelemetry()`:
```javascript
const customErr = validateCustomRule(payload);
if (customErr) return { valid: false, reason: customErr };
```

---

## Troubleshooting

**Packets being dropped with "Packet too old":**
- Check ESP32 system time is in sync
- Increase `MAX_LATENCY_MS` if network is slow

**Observations not saving to MongoDB:**
- Verify `DATASTREAMS` ObjectIds exist in database
- Check MongoDB connection: `echo $MONGODB_URI`
- Ensure `Observation` model has proper schema

**Socket.io not emitting to frontend:**
- Confirm `io.emit()` is being called (check console logs)
- Verify frontend is subscribed to `live_telemetry` event
- Check CORS settings on Socket.io server

**MQTT connection failing:**
- Verify broker URL: `ping test.mosquitto.org`
- Check firewall/network policies
- Test with `mosquitto_sub -h test.mosquitto.org -t 'mfc/#'`

---

## License & Credits

Production-ready modular MQTT listener for OGC SensorThings-compliant IoT systems.
