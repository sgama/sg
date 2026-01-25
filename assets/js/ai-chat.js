export function initChat() {
  const container = document.getElementById('ai-chat-widget');
  
  // Render the chat window inside the widget container
  const windowHtml = `
    <div id="ai-chat-window">
      <div class="ai-chat-header">
        <span>Assistant</span>
        <button id="ai-chat-close" style="background:none;border:none;color:white;cursor:pointer;">&times;</button>
      </div>
      <div class="ai-chat-messages" id="ai-chat-messages">
        <div class="ai-message bot">Hello! I'm an AI assistant trained on this portfolio. Ask me anything about my projects or background.</div>
      </div>
      <form class="ai-chat-input-area" id="ai-chat-form">
        <input type="text" id="ai-chat-input" placeholder="Ask a question..." autocomplete="off">
        <button type="submit" id="ai-chat-send">Send</button>
      </form>
    </div>
  `;
  
  container.insertAdjacentHTML('beforeend', windowHtml);

  const windowEl = document.getElementById('ai-chat-window');
  const toggleBtn = document.getElementById('ai-chat-toggle');
  const closeBtn = document.getElementById('ai-chat-close');
  const form = document.getElementById('ai-chat-form');
  const input = document.getElementById('ai-chat-input');
  const messagesEl = document.getElementById('ai-chat-messages');

  // Open/Close logic
  toggleBtn.addEventListener('click', () => {
    windowEl.classList.add('open');
    document.body.classList.add('ai-chat-open');
    input.focus();
  });

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    windowEl.classList.remove('open');
    document.body.classList.remove('ai-chat-open');
  });

  // Message handling
  function addMessage(text, sender) {
    const div = document.createElement('div');
    div.classList.add('ai-message', sender);
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    addMessage(text, 'user');
    input.value = '';
    input.disabled = true;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: text })
      });

      if (!response.ok) throw new Error('Network response was not ok');
      
      // Streaming Logic
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let botMessageDiv = null;
      let accumuledText = "";

      // Create the message bubble immediately
      addMessage("", 'bot');
      const allMessages = messagesEl.querySelectorAll('.ai-message.bot');
      botMessageDiv = allMessages[allMessages.length - 1];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        
        // Cloudflare Workers AI with stream: true returns Server Sent Events (SSE)
        // Format: "data: {"response":"word"}"
        const lines = chunk.split('\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (dataStr === '[DONE]') continue;
            
            try {
              const json = JSON.parse(dataStr);
              if (json.response) {
                accumuledText += json.response;
                botMessageDiv.textContent = accumuledText;
                messagesEl.scrollTop = messagesEl.scrollHeight;
              }
            } catch (e) {
              // Partial JSON or error, skip
            }
          }
        }
      }
      
    } catch (err) {
      console.error(err);
      addMessage("Sorry, I'm having trouble connecting to the brain right now.", 'bot');
    } finally {
      input.disabled = false;
      input.focus();
    }
  });
}
