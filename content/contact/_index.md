---
title: "Contact"
layout: single
showDate: false
---

## Did we meet somewhere

I’d love to chat! Just fill out the form, and feel free to share how we met or what brought you to my site.


<div class="contact">
  <div class="contact__card">
    <h3 class="text-2xl font-semibold text-neutral-800 dark:text-neutral-200 mb-6">Send a Message</h3>
    <form action="https://formspree.io/f0rm5p33@samsongama.com" method="POST" class="space-12">
      <div>
        <label for="name" class="contact__label">Full Name <span class="text-red-500">*</span></label>
        <input type="text" id="name" name="name" required class="contact__input" placeholder="Your full name">
      </div>
      <div>
        <label for="email" class="contact__label">Email Address <span class="text-red-500">*</span></label>
        <input type="email" id="email" name="email" required class="contact__input" placeholder="your.email@example.com">
      </div>
      <div>
        <label for="subject" class="contact__label">Subject <span class="text-red-500">*</span></label>
        <select id="subject" name="subject" required class="contact__input">
          <option value="">Select a topic...</option>
          <option value="Job Opportunity">Job Opportunity</option>
          <option value="Project Collaboration">Project Collaboration</option>
          <option value="Consulting Inquiry">Consulting Inquiry</option>
          <option value="Speaking Engagement">Speaking Engagement</option>
          <option value="General Question">General Question</option>
          <option value="Other">Other</option>
        </select>
      </div>
      <div>
        <label for="message" class="contact__label">Message <span class="text-red-500">*</span></label>
        <textarea id="message" name="message" rows="6" required class="contact__input contact__input--resizable" placeholder="Tell me about your project, opportunity, or question. I'd love to learn more about what you're working on..."></textarea>
      </div>
      <br>
      <input type="text" name="_gotcha" style="display:none">
      <input type="hidden" name="_next" value="https://samsongama.com/contact?success=true">
      <input type="hidden" name="_subject" value="New Contact Form Submission">
      <button type="submit" class="contact__submit">
        <svg class="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path>
        </svg>
        Send Message
      </button>
    </form>
  </div>
</div>
<div id="success-message" class="contact__success hidden">
  <div class="contact__success-card">
    <div class="flex items-center space-x-3">
      <svg class="w-8 h-8 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
      </svg>
      <div>
        <h3 class="text-lg font-semibold text-green-800 dark:text-green-200">Message Sent Successfully!</h3>
        <p class="text-green-700 dark:text-green-300">Thank you for reaching out. I'll get back to you within 24 hours.</p>
      </div>
    </div>
  </div>
</div>
<script>
document.addEventListener('DOMContentLoaded', function() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('success') === 'true') {
    document.getElementById('success-message').classList.remove('hidden');
    document.getElementById('success-message').scrollIntoView({ behavior: 'smooth' });
    window.history.replaceState({}, document.title, window.location.pathname);
  }
});
</script>
