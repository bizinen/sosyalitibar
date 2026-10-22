"use client";

export function SetupLink() {
  return <a className="btn" href="#connection-setup" onClick={() => {
    const section = document.getElementById("connection-setup");
    if (section instanceof HTMLDetailsElement) section.open = true;
  }}>Bağlantı kurulumunu gör</a>;
}
