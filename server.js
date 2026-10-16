const http = require("http");
const fs = require("fs");
const path = require("path");

// Load .env manually so zero external npm packages are required
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf8");
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const HA_URL = (process.env.HA_URL || "http://192.168.68.30:8123").replace(/\/+$/, "");
const HA_TOKEN = process.env.HA_TOKEN || "";
const PORT = parseInt(process.env.PORT || "3456", 10);

// Strictly whitelisted entities that guests are allowed to view or control
const CONFIG = {
  officeLights: [
    {
      id: "light.shelly1minig4_a085e3bb6a54_switch_0",
      name: "Overhead Lights",
      subtitle: "Main ceiling lights",
      icon: "ceiling-light",
      supportsBrightness: false,
    },
    {
      id: "light.garden_office_lamp",
      name: "Standing Lamp",
      subtitle: "Corner floor lamp",
      icon: "floor-lamp",
      supportsBrightness: true,
    },
    {
      id: "light.garden_office_outside",
      name: "Exterior Wall Lights",
      subtitle: "Garden office up & down lights",
      icon: "wall-sconce",
      supportsBrightness: true,
    },
  ],
  gardenGroup: {
    id: "group.garden_lights",
    name: "Garden Lights",
    subtitle: "Lawn, Backdoor, Hedge & Trees",
    entities: [
      "light.garden_light",
      "light.backdoor_light",
      "light.hedge",
      "light.trees",
    ],
  },
  climate: {
    thermostatId: "climate.tuinkantoor_thermostat",
    acUnitId: "climate.ac_tuinkantoor",
    tempSensorId: "sensor.garden_office_garden_office_temperature_temperature",
    humiditySensorId: "sensor.garden_office_garden_office_temperature_humidity",
  },
  tv: {
    mediaPlayerId: "media_player.garden_office_garden_office_tv",
    remoteId: "remote.garden_office_garden_office_tv",
    broadlinkRemoteId: "remote.office",
  },
  music: {
    configEntryId: "01KFNNM4R6ZEF2S9NQYET8TASD",
    defaultSpeakerId: "media_player.garden_office_4",
    speakers: [
      {
        id: "media_player.garden_office_4",
        hwId: "media_player.garden_office_overhead",
        name: "Overhead Speakers",
        subtitle: "Garden Office Ceiling Amp",
      },
      {
        id: "media_player.garden_office_2",
        fallbackId: "media_player.garden_office_5",
        hwId: "media_player.garden_office",
        name: "Sonos Floor Lamp",
        subtitle: "Garden Office Symfonisk",
      },
    ],
  },
};

const ALLOWED_MUSIC_SPEAKERS = new Set([
  "media_player.garden_office_4",
  "media_player.garden_office_2",
  "media_player.garden_office_5",
]);

const ALLOWED_ENTITIES = new Set([
  ...CONFIG.officeLights.map((l) => l.id),
  ...CONFIG.gardenGroup.entities,
  CONFIG.climate.thermostatId,
  CONFIG.climate.acUnitId,
  CONFIG.climate.tempSensorId,
  CONFIG.climate.humiditySensorId,
  "sensor.garden_office_climate_temperature",
  "sensor.garden_office_climate_humidity",
  CONFIG.tv.mediaPlayerId,
  CONFIG.tv.remoteId,
  CONFIG.tv.broadlinkRemoteId,
  "media_player.garden_office_4",
  "media_player.garden_office_2",
  "media_player.garden_office_5",
  "media_player.garden_office_overhead",
  "media_player.garden_office",
]);

async function haFetch(endpoint, options = {}) {
  const url = `${HA_URL}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${HA_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HA API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function callHaService(domain, service, data, returnResponse = false) {
  const qs = returnResponse ? "?return_response" : "";
  return haFetch(`/api/services/${domain}/${service}${qs}`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

async function getFilteredStates() {
  const allStates = await haFetch("/api/states");
  const stateMap = {};
  for (const s of allStates) {
    if (ALLOWED_ENTITIES.has(s.entity_id)) {
      stateMap[s.entity_id] = {
        entity_id: s.entity_id,
        state: s.state,
        attributes: s.attributes,
        last_updated: s.last_updated,
      };
    }
  }
  return {
    config: CONFIG,
    states: stateMap,
    timestamp: new Date().toISOString(),
  };
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e5) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;

    // API: Get current states
    if (req.method === "GET" && pathname === "/api/state") {
      const data = await getFilteredStates();
      return sendJson(res, 200, data);
    }

    // API: Search Music Assistant (with automatic retry for Spotify rate-limit/timeout & caching)
    if (req.method === "POST" && pathname === "/api/music/search") {
      const body = await parseJsonBody(req);
      const query = String(body.query || "").trim();
      if (!query) {
        return sendJson(res, 400, { error: "Search query is required" });
      }

      const cacheKey = query.toLowerCase();
      if (!global.musicSearchCache) global.musicSearchCache = new Map();
      const cached = global.musicSearchCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
        return sendJson(res, 200, cached.data);
      }

      const combined = {
        tracks: [],
        artists: [],
        playlists: [],
        albums: [],
        radio: [],
      };

      // Music Assistant's Spotify provider often rate-limits or times out internally on the first try,
      // returning an empty tracks array before succeeding on the 2nd or 3rd try.
      // We automatically retry up to 3 times on the backend so the guest never has to search twice.
      let tracksFound = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        const trackResp = await callHaService(
          "music_assistant",
          "search",
          {
            config_entry_id: CONFIG.music.configEntryId,
            name: query,
            media_type: ["track"],
            limit: 8,
          },
          true
        ).catch(() => null);

        const sr = (trackResp && trackResp.service_response) || trackResp;
        if (sr && Array.isArray(sr.tracks) && sr.tracks.length > 0) {
          tracksFound = sr.tracks;
          break;
        }
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 900));
        }
      }

      if (tracksFound.length > 0) {
        combined.tracks.push(...tracksFound);
        // Extract unique top artists from the matched tracks so guests can also tap the artist directly
        const seenArtists = new Set();
        for (const t of tracksFound) {
          for (const a of t.artists || []) {
            if (a && a.uri && a.name && !seenArtists.has(a.uri) && seenArtists.size < 2) {
              seenArtists.add(a.uri);
              combined.artists.push({
                media_type: "artist",
                uri: a.uri,
                name: a.name,
                image: a.image || t.image || null,
              });
            }
          }
        }
      }

      // 2. Also check local library playlists for matching names (instant, no Spotify rate limit)
      const libResp = await callHaService(
        "music_assistant",
        "get_library",
        {
          config_entry_id: CONFIG.music.configEntryId,
          media_type: "playlist",
          search: query,
          limit: 5,
        },
        true
      ).catch(() => null);

      const libSr = (libResp && libResp.service_response) || libResp;
      if (libSr && Array.isArray(libSr.items)) {
        combined.playlists.push(
          ...libSr.items.filter((item) => item.name && item.name.trim().length > 0)
        );
      }

      if (combined.tracks.length > 0 || combined.playlists.length > 0) {
        global.musicSearchCache.set(cacheKey, { ts: Date.now(), data: combined });
      }

      return sendJson(res, 200, combined);
    }

    // API: Get Music Assistant Library (e.g. playlists / tracks)
    if (req.method === "GET" && pathname === "/api/music/library") {
      const mediaType = parsedUrl.searchParams.get("type") || "playlist";
      const resp = await callHaService(
        "music_assistant",
        "get_library",
        {
          config_entry_id: CONFIG.music.configEntryId,
          media_type: mediaType,
          limit: 20,
        },
        true
      );
      return sendJson(res, 200, resp.service_response || resp);
    }

    // API: Proxy local Music Assistant images so guests don't hit mixed-content or unreachable ports
    if (req.method === "GET" && pathname === "/api/music/image") {
      const imgUrl = parsedUrl.searchParams.get("url") || "";
      if (!imgUrl.startsWith("http://192.168.68.30") && !imgUrl.startsWith("https://")) {
        res.writeHead(400);
        return res.end();
      }
      const imgRes = await fetch(imgUrl);
      if (!imgRes.ok) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, {
        "Content-Type": imgRes.headers.get("content-type") || "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      });
      const buf = Buffer.from(await imgRes.arrayBuffer());
      return res.end(buf);
    }

    // API: Perform guest action
    if (req.method === "POST" && pathname === "/api/action") {
      const body = await parseJsonBody(req);
      const { type } = body;

      if (type === "light_toggle") {
        const { entity_id, state } = body;
        if (!ALLOWED_ENTITIES.has(entity_id) || !entity_id.startsWith("light.")) {
          return sendJson(res, 403, { error: "Entity not allowed" });
        }
        const service = state === "on" ? "turn_on" : state === "off" ? "turn_off" : "toggle";
        await callHaService("light", service, { entity_id });
        const updated = await getFilteredStates();
        return sendJson(res, 200, updated);
      }

      if (type === "light_brightness") {
        const { entity_id, brightness_pct } = body;
        if (!ALLOWED_ENTITIES.has(entity_id) || !entity_id.startsWith("light.")) {
          return sendJson(res, 403, { error: "Entity not allowed" });
        }
        const pct = Math.max(0, Math.min(100, Number(brightness_pct)));
        if (pct === 0) {
          await callHaService("light", "turn_off", { entity_id });
        } else {
          await callHaService("light", "turn_on", { entity_id, brightness_pct: pct });
        }
        const updated = await getFilteredStates();
        return sendJson(res, 200, updated);
      }

      if (type === "garden_lights") {
        const { state, brightness_pct } = body;
        const entityIds = CONFIG.gardenGroup.entities;
        if (brightness_pct !== undefined) {
          const pct = Math.max(0, Math.min(100, Number(brightness_pct)));
          if (pct === 0) {
            await callHaService("light", "turn_off", { entity_id: entityIds });
          } else {
            await callHaService("light", "turn_on", { entity_id: entityIds, brightness_pct: pct });
          }
        } else {
          const service = state === "on" ? "turn_on" : "turn_off";
          await callHaService("light", service, { entity_id: entityIds });
        }
        const updated = await getFilteredStates();
        return sendJson(res, 200, updated);
      }

      if (type === "climate_mode") {
        const { hvac_mode } = body;
        const allowedModes = ["off", "auto", "cool", "heat", "heat_cool"];
        if (!allowedModes.includes(hvac_mode)) {
          return sendJson(res, 400, { error: "Invalid HVAC mode" });
        }
        await callHaService("climate", "set_hvac_mode", {
          entity_id: CONFIG.climate.thermostatId,
          hvac_mode,
        });
        const updated = await getFilteredStates();
        return sendJson(res, 200, updated);
      }

      if (type === "climate_preset") {
        const { preset_mode } = body;
        const allowedPresets = ["none", "sleep", "comfort", "away", "home"];
        if (!allowedPresets.includes(preset_mode)) {
          return sendJson(res, 400, { error: "Invalid preset mode" });
        }
        await callHaService("climate", "set_preset_mode", {
          entity_id: CONFIG.climate.thermostatId,
          preset_mode,
        });
        const updated = await getFilteredStates();
        return sendJson(res, 200, updated);
      }

      if (type === "climate_temp") {
        const { temperature, target_temp_low, target_temp_high } = body;
        const payload = { entity_id: CONFIG.climate.thermostatId };
        if (target_temp_low !== undefined && target_temp_high !== undefined) {
          payload.target_temp_low = Math.max(15, Math.min(30, Number(target_temp_low)));
          payload.target_temp_high = Math.max(15, Math.min(30, Number(target_temp_high)));
        } else if (temperature !== undefined) {
          payload.temperature = Math.max(15, Math.min(30, Number(temperature)));
        }
        await callHaService("climate", "set_temperature", payload);
        const updated = await getFilteredStates();
        return sendJson(res, 200, updated);
      }

      if (type === "tv_command") {
        const { command } = body;
        const remoteId = CONFIG.tv.remoteId;
        const mediaPlayerId = CONFIG.tv.mediaPlayerId;

        const keyMap = {
          up: "DPAD_UP",
          down: "DPAD_DOWN",
          left: "DPAD_LEFT",
          right: "DPAD_RIGHT",
          select: "DPAD_CENTER",
          back: "BACK",
          home: "HOME",
          menu: "MENU",
          play_pause: "MEDIA_PLAY_PAUSE",
          volume_up: "VOLUME_UP",
          volume_down: "VOLUME_DOWN",
          mute: "VOLUME_MUTE",
          power: "POWER",
        };

        if (command === "power_toggle") {
          await callHaService("remote", "send_command", {
            entity_id: remoteId,
            command: "POWER",
          });
        } else if (command === "volume_up") {
          await callHaService("media_player", "volume_up", { entity_id: mediaPlayerId });
        } else if (command === "volume_down") {
          await callHaService("media_player", "volume_down", { entity_id: mediaPlayerId });
        } else if (command === "mute") {
          await callHaService("remote", "send_command", {
            entity_id: remoteId,
            command: "VOLUME_MUTE",
          });
        } else if (keyMap[command]) {
          await callHaService("remote", "send_command", {
            entity_id: remoteId,
            command: keyMap[command],
          });
        } else {
          return sendJson(res, 400, { error: "Unknown TV command" });
        }

        const updated = await getFilteredStates();
        return sendJson(res, 200, updated);
      }

      if (type === "music_play_media") {
        const { entity_id, media_id, media_type, radio_mode } = body;
        let speakerId = ALLOWED_MUSIC_SPEAKERS.has(entity_id)
          ? entity_id
          : CONFIG.music.defaultSpeakerId;
        if (speakerId === "media_player.garden_office_5") {
          speakerId = "media_player.garden_office_2";
        }
        if (!media_id) {
          return sendJson(res, 400, { error: "media_id is required" });
        }
        const payload = {
          entity_id: speakerId,
          media_id,
          enqueue: "play",
          radio_mode: radio_mode !== undefined ? Boolean(radio_mode) : false,
        };
        if (media_type) payload.media_type = media_type;

        // 1. Load & queue stream in Music Assistant (retry once if Spotify throws transient error)
        try {
          await callHaService("music_assistant", "play_media", payload);
        } catch (err) {
          await new Promise((r) => setTimeout(r, 600));
          await callHaService("music_assistant", "play_media", payload);
        }

        // 2. UPnP/Linkplay speakers (Sonos & Overhead Amp) finish loading the stream URL ~500ms
        // after play_media returns and settle into "paused". Sending media_play after 600ms
        // (and again at 1400ms in background) guarantees immediate playback without needing a second click.
        const hwSpeakerId =
          speakerId === "media_player.garden_office_2"
            ? "media_player.garden_office"
            : "media_player.garden_office_overhead";

        await new Promise((r) => setTimeout(r, 600));
        await Promise.all([
          callHaService("media_player", "media_play", { entity_id: speakerId }).catch(() => {}),
          callHaService("media_player", "media_play", { entity_id: hwSpeakerId }).catch(() => {}),
        ]);

        setTimeout(() => {
          callHaService("media_player", "media_play", { entity_id: speakerId }).catch(() => {});
          callHaService("media_player", "media_play", { entity_id: hwSpeakerId }).catch(() => {});
        }, 900);

        const updated = await getFilteredStates();
        return sendJson(res, 200, updated);
      }

      if (type === "music_control") {
        const { entity_id, command, volume_level } = body;
        let speakerId = ALLOWED_MUSIC_SPEAKERS.has(entity_id)
          ? entity_id
          : CONFIG.music.defaultSpeakerId;
        if (speakerId === "media_player.garden_office_5") {
          speakerId = "media_player.garden_office_2";
        }

        if (command === "play_pause") {
          await callHaService("media_player", "media_play_pause", { entity_id: speakerId });
        } else if (command === "next") {
          await callHaService("media_player", "media_next_track", { entity_id: speakerId });
        } else if (command === "previous") {
          await callHaService("media_player", "media_previous_track", { entity_id: speakerId });
        } else if (command === "stop") {
          await callHaService("media_player", "media_stop", { entity_id: speakerId });
        } else if (command === "volume_set" && volume_level !== undefined) {
          const vol = Math.max(0, Math.min(1, Number(volume_level)));
          await callHaService("media_player", "volume_set", {
            entity_id: speakerId,
            volume_level: vol,
          });
        } else {
          return sendJson(res, 400, { error: "Invalid music control command" });
        }
        const updated = await getFilteredStates();
        return sendJson(res, 200, updated);
      }

      return sendJson(res, 400, { error: "Unknown action type" });
    }

    // Serve static files from ./public
    let filePath = pathname === "/" ? "/index.html" : pathname;
    const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, "");
    const absPath = path.join(__dirname, "public", safePath);

    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      const ext = path.extname(absPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType });
      fs.createReadStream(absPath).pipe(res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  } catch (err) {
    console.error("Server error:", err.message);
    sendJson(res, 500, { error: err.message || "Internal server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Guest Assistant running at http://localhost:${PORT}`);
});
