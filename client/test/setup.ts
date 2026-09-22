// Runs before each client spec file. The document gets the real admin shell, the body of
// public/dashboard/index.html, because the shell module reads its roots (#app, #identity,
// #toasts, the nav) at import time and the app is only ever mounted into that page. The
// inline scripts are dropped: they set a sidebar mode before first paint, nothing a spec
// asserts on.

import page from "../../public/dashboard/index.html?raw";

const body = page.slice(page.indexOf("<body>") + "<body>".length, page.lastIndexOf("</body>"));
document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "");
