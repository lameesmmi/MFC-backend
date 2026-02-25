const mqtt = require('mqtt');

// Connect to your local broker using your Hotspot IP
const client = mqtt.connect('mqtt://172.20.10.13:1883');

client.on('connect', () => {
    console.log("✅ Mock ESP32 connected to broker!");
    
    // Send data every 5 seconds
    setInterval(() => {
        const mockData = {
            timestamp: new Date().toISOString(), // Real current time to pass your validator
            ph: (6.5 + Math.random() * 2).toFixed(2) * 1, // Random 6.5 - 8.5
            tds: Math.floor(Math.random() * 1000) + 500,
            temperature: 25.5,
            flow_rate: 1.2,
            salinity: 300,
            conductivity: 400,
            current: 0.5,
            voltage: 12.0,
            power: 6.0,
            valve_status: "OPEN"
        };

        client.publish('mfc/system_01/telemetry', JSON.stringify(mockData));
        console.log("📡 Sent Mock Telemetry:", mockData.ph);
    }, 5000);
});