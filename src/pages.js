// Static trust pages (needed for Google trust signals and AdSense approval). Edit the wording to suit you.
module.exports = {
  'about-us': s => ({ title: 'About Us', html: `
<p>${s.site_name} is an independent information portal for people preparing for government jobs in India. We track recruitment notices, admit cards, results, answer keys and admission forms, and summarise them in a simple, consistent format.</p>
<p>Every update links to the official website of the recruiting body. We are not a government website and are not connected with any department or organisation.</p>` }),
  'contact-us': s => ({ title: 'Contact Us', html: `
<p>Found a mistake or have a suggestion? We would like to hear from you.</p>
<p>${s.contact_email ? `E-mail: <a href="mailto:${s.contact_email}">${s.contact_email}</a>` : 'Add your contact e-mail in Admin → Settings.'}</p>` }),
  'disclaimer': s => ({ title: 'Disclaimer', html: `
<p>The information on ${s.site_name} is collected from official notifications and public sources and is provided for general guidance only. While we try to keep it accurate, mistakes can happen and dates can change.</p>
<p>Always check the official notification and website before applying, paying a fee or travelling for an exam. ${s.site_name} is not responsible for any loss arising from use of this information, and is not affiliated with any government body.</p>` }),
  'privacy-policy': s => ({ title: 'Privacy Policy', html: `
<p>${s.site_name} does not ask visitors to create an account. We may use cookies for analytics and advertising (for example Google Analytics and Google AdSense). These services may collect anonymous usage data under their own privacy policies.</p>
<p>You can disable cookies in your browser settings. For questions about this policy, please use the Contact Us page.</p>` })
};
