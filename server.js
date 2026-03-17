const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

// 🚀 CONFIG
const GEO_FENCE_RADIUS = 0.1;
const STATUS_CHECK_INTERVAL = 2000;
const MAX_STATUS_CHECKS = 3;
let dumpsterGeofences = new Map();
let proximityChecks = new Map();

// 🔥 ESP CACHE (prevent spam)
const espCache = new Map();

// Traccar config
const TRACCAR_URL = 'http://localhost:8082/api';
const TRACCAR_USER = 'admin';
const TRACCAR_PASS = 'admin';

let GARBAGE_DUMP = null;
let dumpsters = [];
let trucks = [];
let truckRoutes = {};

// PostgreSQL
const pool = new Pool({
  user: 'waste_user', 
  host: 'localhost', 
  database: 'waste_db', 
  password: 'securepass', 
  port: 5432
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 🧠 DISTANCE CALCULATION (Haversine)
function getDistance(truckCoords, dumpsterCoords) {
  const lat1 = truckCoords.lat || truckCoords[0] || 42.00;
  const lon1 = truckCoords.lng || truckCoords[1] || 21.42;
  const lat2 = dumpsterCoords.lat || dumpsterCoords[0] || 42.00;
  const lon2 = dumpsterCoords.lng || dumpsterCoords[1] || 21.42;
  
  const R = 6371e3;
  const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180, Δλ = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) * Math.sin(Δλ/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function isWithinGeofence(truck, geofence) {
  return getDistance({lat: truck.lat, lng: truck.lng}, {lat: geofence.lat, lng: geofence.lng}) <= geofence.radius;
}

// 🔥 ESP CHECK WITH 10s CACHE - NO MORE SPAM!
async function checkDumpsterStatus(ip) {
  if (!ip || ip === '') return null;
  
  const cacheKey = `esp_${ip}`;
  const lastCheck = espCache.get(cacheKey);
  if (lastCheck && Date.now() - lastCheck.timestamp < 10000) {
    return lastCheck.data; // Return cached result
  }
  
  try {
    const response = await axios.get(`http://${ip}/status`, { 
      timeout: 2000,
      validateStatus: () => true 
    });
    
    if (response.status === 200) {
      const data = response.data;
      console.log(`✅ ESP ${ip} LIVE: ${data.fillLevel}%`);
      espCache.set(cacheKey, { data, timestamp: Date.now() });
      return data;
    }
  } catch (e) {
    // Silent fail after first log
    if (!lastCheck) {
      console.log(`🔇 ESP ${ip} OFFLINE (10s cooldown)`);
    }
  }
  
  espCache.set(cacheKey, { data: null, timestamp: Date.now() });
  return null;
}

// 🔥 PROXIMITY CHECK - FULLY FIXED
async function checkTruckProximity() {
  for (const [truckId, route] of Object.entries(truckRoutes)) {
    const truck = route.truck;
    if (!truck?.lat || !truck?.lng) continue;
    
    for (const dumpster of (route.dumpsters || [])) {
      const geofence = dumpsterGeofences.get(dumpster.id);
      if (!geofence?.ip) continue;
      
      const key = `${truckId}-${dumpster.id}`;
      
      if (isWithinGeofence(truck, geofence)) {
        let checkData = proximityChecks.get(key) || { 
          checks: 0, lastFill: null, lastEmpty: false, lastEmptyTime: null 
        };
        
        if (checkData.checks < MAX_STATUS_CHECKS) {
          const freshData = await checkDumpsterStatus(geofence.ip);
          if (freshData) {
            // 🕐 TIME-TO-EMPTY
            if (checkData.lastFill && freshData.fillLevel < checkData.lastFill - 20) {
              const timeToEmpty = checkData.checks * 5;
              console.log(`🚛 EMPTIED ${dumpster.name}: -${Math.round((checkData.lastFill - freshData.fillLevel)*10)/10}% in ${timeToEmpty}s`);
            }
            
            checkData.checks++;
            checkData.lastFill = freshData.fillLevel;
            checkData.lastEmpty = freshData.fillLevel < 10;
            checkData.lastEmptyTime = Date.now();
            proximityChecks.set(key, checkData);
            
            // 💾 UPDATE GLOBAL STATE
            const updatedDumpster = {
              ...dumpster,
              attributes: freshData,
              priority: getPriority(freshData.fillLevel, freshData.temp, freshData.humidity)
            };
            
            const idx = dumpsters.findIndex(d => d.id === dumpster.id);
            if (idx !== -1) {
              dumpsters[idx] = updatedDumpster;
              io.emit('dumpsters', dumpsters);
            }
            
            // 🚀 REOPTIMIZE ROUTES
            if (freshData.fillLevel < 10) {
              console.log(`🧠 REOPTIMIZE: ${dumpster.name} EMPTY (${freshData.fillLevel}%)`);
              truckRoutes = assignSmartRoutes(trucks, dumpsters);
              io.emit('routes', truckRoutes);
            } else if (freshData.priority >= 8) {
              console.log(`🚨 CRITICAL: ${dumpster.name} (${freshData.priority})`);
              truckRoutes = assignSmartRoutes(trucks, dumpsters);
              io.emit('routes', truckRoutes);
            }
          }
        }
      } else {
        // 🚛 TRUCK LEFT - POST-EMPTYING CHECK
        const checkData = proximityChecks.get(key);
        if (checkData?.lastEmpty && checkData.lastEmptyTime) {
          const timeSinceEmpty = Date.now() - checkData.lastEmptyTime;
          if (timeSinceEmpty < 30000) {
            setTimeout(async () => {
              const verifyData = await checkDumpsterStatus(geofence.ip);
              if (verifyData?.fillLevel < 15) {
                console.log(`✅ CONFIRMED EMPTY: ${dumpster.name} (${verifyData.fillLevel}%) - POST TRUCK`);
                const updatedDumpster = {
                  ...dumpster,
                  attributes: verifyData,
                  priority: getPriority(verifyData.fillLevel, verifyData.temp || 20, verifyData.humidity || 50)
                };
                
                const idx = dumpsters.findIndex(d => d.id === dumpster.id);
                if (idx !== -1) {
                  dumpsters[idx] = updatedDumpster;
                  io.emit('dumpsters', dumpsters);
                }
                
                truckRoutes = assignSmartRoutes(trucks, dumpsters);
                io.emit('routes', truckRoutes);
              }
            }, 30000 - timeSinceEmpty);
          }
        }
        proximityChecks.delete(key);
      }
    }
  }
}

async function saveDumpsterHistory(deviceId, fillLevel, temp, humidity, priority, lat, lng, ip = null) {
  try {
    await pool.query(`
      INSERT INTO sensor_data (dumpster_id, fill_level, temp, humidity, priority, lat, lng, ip)
      VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, ''))
    `, [deviceId.toString(), fillLevel, temp, humidity, priority, lat, lng, ip]);
  } catch (e) {
    console.error(`❌ DB ${deviceId}:`, e.message);
  }
}

function assignSmartRoutes(trucks, dumpsters) {
  if (!trucks.length || !dumpsters.length || !GARBAGE_DUMP) return {};
  
  const sortedDumpsters = [...dumpsters]
    .filter(d => d.id !== 'DUMP_001' && d.attributes?.fillLevel > 10)
    .sort((a, b) => b.priority - a.priority);
    
  const assignments = {};
  trucks.forEach((truck) => {
    const truckPos = [truck.lat || 42.00, truck.lng || 21.42];
    let route = [], totalWeight = 0;
    const TRUCK_CAPACITY = 20, DUMPSTER_WEIGHT = 5;
    
    while (totalWeight + DUMPSTER_WEIGHT <= TRUCK_CAPACITY && sortedDumpsters.length > 0) {
      let closest = null, closestDist = Infinity;
      sortedDumpsters.forEach(d => {
        const dist = getDistance(truckPos, [d.lat, d.lng]);
        if (dist < closestDist) {
          closestDist = dist;
          closest = d;
        }
      });
      
      if (closest) {
        route.push(closest);
        totalWeight += DUMPSTER_WEIGHT;
        const closestIdx = sortedDumpsters.indexOf(closest);
        sortedDumpsters.splice(closestIdx, 1);
        truckPos[0] = closest.lat;
        truckPos[1] = closest.lng;
      } else break;
    }
    
    if (route.length > 0) route.push(GARBAGE_DUMP);
    
    if (route.length > 1) {
      assignments[truck.id] = {
        truck, dumpsters: route,
        totalWeight: Math.round(totalWeight * 10) / 10,
        stopCount: route.length,
        highPriorityCount: route.filter(d => d.priority >= 8).length,
        totalDistance: route.reduce((sum, d, i) => {
          if (i === 0) return getDistance(truck, d);
          return sum + getDistance(route[i-1], d);
        }, 0)
      };
    }
  });
  return assignments;
}

function getPriority(fillLevel, temp, humidity) {
  let score = 0;
  if (fillLevel > 90) score += 10;
  else if (fillLevel > 70) score += 8;
  if (temp > 50) score += 5;
  else if (temp > 35) score += 3;
  if (humidity > 85) score += 3;
  return Math.min(10, score);
}

async function fetchDumpsters() {
  try {
    const auth = Buffer.from(`${TRACCAR_USER}:${TRACCAR_PASS}`).toString('base64');
    const [devicesRes, positionsRes, geofencesRes] = await Promise.all([
      axios.get(`${TRACCAR_URL}/devices`, { headers: { 'Authorization': `Basic ${auth}` } }),
      axios.get(`${TRACCAR_URL}/positions`, { headers: { 'Authorization': `Basic ${auth}` } }),
      axios.get(`${TRACCAR_URL}/geofences`, { headers: { 'Authorization': `Basic ${auth}` } })
    ]);
    
    const devices = devicesRes.data;
    const positions = positionsRes.data;
    const geofences = geofencesRes.data;
    
    console.log('🔍 DEVICES:', devices.length, 'POSITIONS:', positions.length);
    console.log('🗺️ GEOFENCES:', geofences.map(g => g.name));
    
    // 🗑️ GARBAGE DUMP
    const dumpGeofence = geofences.find(g => 
      g.name.toLowerCase().includes('deponija') || g.name.toLowerCase().includes('dump')
    );
    
    if (dumpGeofence) {
      const coords = dumpGeofence.area.match(/[+-]?\d+\.?\d*\s+[+-]?\d+\.?\d*/g);
      if (coords?.length > 0) {
        const firstCoord = coords[0].trim().split(/\s+/);
        GARBAGE_DUMP = {
          id: 'DUMP_001', name: dumpGeofence.name,
          lat: parseFloat(firstCoord[0]), lng: parseFloat(firstCoord[1]),
          priority: 0, attributes: { fillLevel: 0 }
        };
        console.log('✅ DUMP:', GARBAGE_DUMP.lat.toFixed(6), GARBAGE_DUMP.lng.toFixed(6));
      }
    }
    
    if (!GARBAGE_DUMP) {
      GARBAGE_DUMP = {
        id: 'DUMP_001', name: 'Skopje Deponija',
        lat: 41.9973, lng: 21.4280, priority: 0, attributes: { fillLevel: 0 }
      };
    }
    
    // 🗑️ DUMPSTERS
    const dumpsterDevices = devices.filter(d => !String(d.name || '').toLowerCase().includes('kamion'));
    console.log('🗑️ DUMPSTERS:', dumpsterDevices.length);
    
    const allDumpsters = await Promise.all(dumpsterDevices.map(async (device) => {
      const pos = positions
        .filter(p => p.deviceId == device.id)
        .sort((a,b) => new Date(b.serverTime) - new Date(a.serverTime))[0];
      
      const attrs = pos?.attributes || {};
      const fillLevel = Number(attrs.fillLevel || 0);
      const temp = Number(attrs.temp || 20);
      const humidity = Number(attrs.humidity || 50);
      const ip = attrs.ip || attrs.esp_ip || attrs.deviceIP || '';
      const priority = getPriority(fillLevel, temp, humidity);
      
      if (pos) {
        const geofence = { lat: pos.latitude, lng: pos.longitude, radius: GEO_FENCE_RADIUS, ip };
        dumpsterGeofences.set(device.id.toString(), geofence);
        await saveDumpsterHistory(device.id, fillLevel, temp, humidity, priority, 
          pos.latitude, pos.longitude, ip);
        console.log(`✅ ${device.id} (${device.name || 'Kanta'}) ${fillLevel}% IP:${ip}`);
      }
      
      return { 
        id: device.id.toString(),
        name: device.name || `Kanta ${device.id}`,
        lat: pos?.latitude || 42.00, 
        lng: pos?.longitude || 21.42,
        ip: ip || null,
        lastUpdate: pos?.serverTime,
        attributes: { fillLevel, temp, humidity },
        priority
      };
    }));
    
    dumpsters = [...allDumpsters, GARBAGE_DUMP];
    
    // 🚛 TRUCKS
    trucks = devices
      .filter(d => String(d.name || '').toLowerCase().includes('kamion'))
      .map(device => {
        const pos = positions.find(p => p.deviceId == device.id);
        return { 
          id: device.id,
          name: device.name,
          lat: pos?.latitude || 42.00, 
          lng: pos?.longitude || 21.42
        };
      });
    
    truckRoutes = assignSmartRoutes(trucks, dumpsters);
    
    io.emit('dumpsters', dumpsters);
    io.emit('trucks', trucks);
    io.emit('routes', truckRoutes);
    
  } catch (error) {
    console.error('❌ Traccar:', error.message);
  }
}

// 🔌 SOCKETS
io.on('connection', (socket) => {
  console.log('🌐 Connected:', socket.id);
  socket.emit('dumpsters', dumpsters);
  socket.emit('trucks', trucks);
  socket.emit('routes', truckRoutes);
  
  socket.on('optimize-routes', () => {
    truckRoutes = assignSmartRoutes(trucks, dumpsters);
    io.emit('routes', truckRoutes);
    console.log('🔄 Routes optimized');
  });
  
  socket.on('clear-routes', () => {
    truckRoutes = {};
    io.emit('routes', {});
    console.log('🗑️ Routes cleared');
  });
});

// 🚀 START
server.listen(3000, () => {
  console.log('🚛 Skopje Waste Management: http://localhost:3000');
  fetchDumpsters();
});

setInterval(fetchDumpsters, 30000);           // Traccar sync
setInterval(checkTruckProximity, 5000);       // Truck proximity
