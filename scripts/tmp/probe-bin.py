import struct, subprocess, base64, json
out = subprocess.run(["solana","account","5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6","--url","mainnet-beta"],capture_output=True)
