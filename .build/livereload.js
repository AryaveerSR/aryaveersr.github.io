const socketUrl = "ws://localhost:!!PORT!!"; // The script replaces this with the actual port

let socket = new WebSocket(socketUrl);
socket.addEventListener("message", (msg) => location.reload());
