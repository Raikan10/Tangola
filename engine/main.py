import asyncio
import websockets
import json
import logging
from adapter import get_adapter
from vad import VADGate

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

async def heartbeat(websocket):
    """Sends a ping every 2 seconds to Electron so it knows the engine is alive."""
    while True:
        try:
            await websocket.send(json.dumps({"type": "heartbeat", "status": "alive"}))
            await asyncio.sleep(2)
        except websockets.exceptions.ConnectionClosed:
            break

async def send_audio(websocket, adapter):
    """Streams audio chunks in a non-blocking thread to the WebSocket.

    A VAD gate drops silence before it leaves the engine, so only speech is
    streamed to Electron (and onward to Sarvam). Silence gaps therefore show up
    downstream as a pause in binary traffic, which the provider uses to idle-
    close / reconnect its Sarvam socket."""
    loop = asyncio.get_running_loop()
    gate = VADGate()
    if gate.enabled:
        logging.info("VAD gate active — streaming speech only (silence dropped).")
    else:
        logging.warning("VAD gate disabled — streaming all audio including silence.")

    def audio_generator():
        for chunk in adapter.get_audio_stream():
            yield chunk

    stream = audio_generator()
    logging.info("Started streaming audio...")

    while adapter.is_recording:
        try:
            # Offload the blocking audio capture to a thread so asyncio event loop stays fast
            chunk = await loop.run_in_executor(None, stream.__next__)
            # Gate out silence, then send the speech frames as one message
            # (coalesced to keep wire granularity ~= one capture chunk).
            frames = b"".join(gate.process(chunk))
            if frames:
                await websocket.send(frames)
        except StopIteration:
            break
        except websockets.exceptions.ConnectionClosed:
            break
        except Exception as e:
            logging.error(f"Audio stream error: {e}")
            break
            
    logging.info("Stopped streaming audio.")

async def connection_handler(websocket):
    logging.info("Electron UI connected.")
    adapter = get_adapter()
    heartbeat_task = asyncio.create_task(heartbeat(websocket))
    audio_task = None

    try:
        async for message in websocket:
            try:
                # We expect JSON commands from Electron
                if isinstance(message, str):
                    req = json.loads(message)
                    if req.get('action') == 'start':
                        if not adapter.is_recording:
                            adapter.start()
                            audio_task = asyncio.create_task(send_audio(websocket, adapter))
                            await websocket.send(json.dumps({"type": "status", "status": "recording_started"}))
                    
                    elif req.get('action') == 'stop':
                        adapter.stop()
                        if audio_task:
                            await audio_task
                        await websocket.send(json.dumps({"type": "status", "status": "recording_stopped"}))
            except json.JSONDecodeError:
                pass
    finally:
        adapter.stop()
        heartbeat_task.cancel()
        if audio_task:
            audio_task.cancel()
        logging.info("Electron UI disconnected or connection lost.")

async def main():
    async with websockets.serve(connection_handler, "localhost", 8765):
        logging.info("Tangola Engine listening on ws://localhost:8765")
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    try:
        get_adapter() # Verify we can instantiate the adapter for the current OS
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info("Engine shutting down.")
