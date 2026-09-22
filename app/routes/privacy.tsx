export default function Privacy() {
  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif", lineHeight: 1.6 }}>
      <h1>CartLift privacy policy</h1>
      <p>Last updated: September 22, 2026</p>
      <h2>What we collect</h2>
      <p>
        When a merchant installs CartLift we store the shop domain, shop name, contact email and currency, plus the
        deals the merchant creates. To report results we store aggregate counts (deal views, add-to-carts, orders) and,
        for checkouts that contained a CartLift deal, the order id and amounts. We do not collect or store shoppers'
        names, emails, addresses or payment details.
      </p>
      <p>
        CartLift also reads the store's markets, languages and product unit costs (to target deals, translate them
        and show profit in analytics), and stores images the merchant uploads for deals in the store's own Shopify
        Files.
      </p>
      <h2>How we use it</h2>
      <p>Only to run the app: show deals on the storefront, price them at checkout, and show analytics to the merchant.</p>
      <h2>Sharing</h2>
      <p>We do not sell or share data with third parties. Data is hosted on our own servers.</p>
      <h2>Retention and deletion</h2>
      <p>
        When a merchant uninstalls CartLift, all of their shop data is deleted within 48 hours after Shopify sends the
        shop/redact request.
      </p>
      <h2>Contact</h2>
      <p>Questions: contact the CartLift team through the support link in the app.</p>
    </main>
  );
}
