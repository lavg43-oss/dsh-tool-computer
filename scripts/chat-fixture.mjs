/**
 * Servidor de prueba local: imita un chat web.
 *
 * Tiene un compositor `contenteditable` (como Gemini, que no usa <textarea>) y,
 * al enviar, escribe la respuesta **palabra por palabra** con retrasos, que es
 * exactamente lo que hace un chat real. Sirve para comprobar que `settle` espera
 * a que termine el streaming en vez de leer la respuesta a medias.
 *
 * Uso: node scripts/chat-fixture.mjs [puerto]
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 8731)

const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fake Chat</title></head>
<body>
  <h1>Fake Chat</h1>
  <div id="log"></div>
  <div id="composer" contenteditable="true" role="textbox" aria-label="Message" style="border:1px solid #999; min-height:40px; width:400px"></div>
  <button id="send">Send</button>
  <script>
    const log = document.getElementById('log')
    const composer = document.getElementById('composer')
    const ANSWER = 'Esta respuesta llega token a token y solo debe leerse cuando termine de escribirse por completo.'
    async function send() {
      const asked = composer.innerText
      composer.innerText = ''
      const turn = document.createElement('div')
      const question = document.createElement('p')
      question.textContent = 'You: ' + asked
      const answer = document.createElement('p')
      answer.id = 'answer'
      turn.appendChild(question)
      turn.appendChild(answer)
      log.appendChild(turn)
      const stop = document.createElement('button')
      stop.id = 'stop'
      stop.setAttribute('aria-label', 'Stop generating')
      stop.textContent = 'Stop'
      turn.appendChild(stop)
      for (const word of ANSWER.split(' ')) {
        await new Promise((resolve) => setTimeout(resolve, 350))
        answer.textContent += word + ' '
      }
      stop.remove()
    }
    document.getElementById('send').addEventListener('click', send)
    composer.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() } })
  </script>
</body>
</html>`

createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(page)
}).listen(port, '127.0.0.1', () => {
  console.log(`chat fixture listening on http://127.0.0.1:${port}`)
})
