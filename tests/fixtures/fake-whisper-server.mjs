// A stand-in for whisper.cpp's whisper-server: same flags, /health and
// /inference. FAKE_WHISPER_DELAY_MS delays readiness (model loading).
import { createServer } from "node:http";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const model = args[args.indexOf("-m") + 1];
const readyAt = Date.now() + Number(process.env.FAKE_WHISPER_DELAY_MS ?? 0);
createServer((req, res) => {
	if (req.method === "GET" && req.url === "/health") {
		if (Date.now() < readyAt) return res.writeHead(503, { "content-type": "application/json" }).end('{"status":"loading model"}');
		return res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
	}
	if (req.method === "POST" && req.url === "/inference") {
		let body = "";
		req.setEncoding("latin1");
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			const language = /name="language"\r\n\r\n([^\r]*)/.exec(body)?.[1];
			const hasWav = body.includes("RIFF") && body.includes("WAVE");
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: ` heard ${hasWav ? "wav" : "nothing"} in ${language} with ${model.split("/").pop()} ` }));
		});
		return;
	}
	res.writeHead(404).end();
}).listen(port, "127.0.0.1");
