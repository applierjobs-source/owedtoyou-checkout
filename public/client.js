const checkoutButton = document.getElementById("checkoutButton");
const checkoutStatus = document.getElementById("checkoutStatus");

const params = new URLSearchParams(window.location.search);
if (params.get("checkout") === "success") {
  checkoutStatus.textContent = "Payment completed. Thank you - we'll begin processing your request.";
  checkoutStatus.style.color = "#0b7c3f";
}

if (params.get("checkout") === "cancelled") {
  checkoutStatus.textContent = "Checkout was canceled. You can try again anytime.";
  checkoutStatus.style.color = "#8f2140";
}

checkoutButton?.addEventListener("click", async () => {
  checkoutStatus.textContent = "Redirecting to secure checkout...";
  checkoutStatus.style.color = "#333f82";
  checkoutButton.disabled = true;

  try {
    const response = await fetch("/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });

    const data = await response.json();
    if (!response.ok || !data.url) {
      throw new Error(data.error || "Unable to start checkout.");
    }

    window.location.href = data.url;
  } catch (error) {
    checkoutStatus.textContent = error.message || "Something went wrong. Please try again.";
    checkoutStatus.style.color = "#ae2456";
    checkoutButton.disabled = false;
  }
});
