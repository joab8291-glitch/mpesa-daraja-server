const SYMBOLS = ["EUR/USD","GBP/USD","USD/JPY","AUD/USD","USD/CAD","USD/CHF"];
const prices = new Map();
let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let stopped = false;

function getQuotes() {
  return SYMBOLS.map(symbol => ({ symbol, ...(prices.get(symbol) || { price:null, bid:null, ask:null, timestamp:null }) }));
}

function startForexMarket({ onPrice } = {}) {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    console.warn("[forex-market] TWELVE_DATA_API_KEY is not configured; live quotes and automatic SL/TP are disabled.");
    return;
  }
  if (typeof WebSocket === "undefined") {
    console.error("[forex-market] Node WebSocket API is unavailable. Use Node 22+.");
    return;
  }
  stopped = false;
  const connect = () => {
    if (stopped) return;
    try {
      socket = new WebSocket("wss://ws.twelvedata.com/v1/quotes/price?apikey=" + encodeURIComponent(apiKey));
      socket.addEventListener("open", () => {
        console.log("[forex-market] Twelve Data WebSocket connected.");
        socket.send(JSON.stringify({ action:"subscribe", params:{ symbols:SYMBOLS.join(",") } }));
        heartbeatTimer = setInterval(() => {
          if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ action:"heartbeat" }));
        }, 10000);
      });
      socket.addEventListener("message", async event => {
        try {
          const data = JSON.parse(String(event.data));
          if (data.event !== "price" || !SYMBOLS.includes(data.symbol) || !Number.isFinite(Number(data.price))) return;
          const quote = {
            symbol:data.symbol,
            price:Number(data.price),
            bid:Number.isFinite(Number(data.bid)) ? Number(data.bid) : Number(data.price),
            ask:Number.isFinite(Number(data.ask)) ? Number(data.ask) : Number(data.price),
            timestamp:Number(data.timestamp) || Math.floor(Date.now()/1000),
          };
          prices.set(data.symbol, quote);
          if (onPrice) await onPrice(quote);
        } catch (error) {
          console.error("[forex-market] Quote processing failed:", error.message);
        }
      });
      socket.addEventListener("error", () => console.error("[forex-market] WebSocket error."));
      socket.addEventListener("close", () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        if (!stopped) reconnectTimer = setTimeout(connect, 5000);
      });
    } catch (error) {
      console.error("[forex-market] Connection failed:", error.message);
      reconnectTimer = setTimeout(connect, 5000);
    }
  };
  connect();
}

module.exports = { SYMBOLS, getQuotes, startForexMarket };
