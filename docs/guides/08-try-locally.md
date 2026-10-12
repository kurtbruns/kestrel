# Try Kestrel locally first

You can run Kestrel on your own computer to look around before you deploy it. It needs no Cloudflare account and no Git host. Email goes to a stand-in on your computer, so nothing reaches a real inbox.

In this guide, you write a new instance into an empty folder, start the app, and open the editor. Then you fill it with a demo publication, and empty it again. The folder can become your instance's repository later.

## Before you begin

- [Node.js](https://nodejs.org/) 22 or later

## 1. Write a new instance

An instance is a small folder of your own. It holds the instance's settings and names the release of Kestrel it runs, which installs from npm as `@kurtbruns/kestrel`.

1. Make an empty folder, and go into it:

    ```bash
    mkdir newsletter
    cd newsletter
    ```

1. Write a new instance into it:

    ```bash
    npx @kurtbruns/kestrel init
    ```

    It writes the instance's files, and lists the commands to run next. The folder doesn't need to be a Git repository.

1. Install the release and its tools:

    ```bash
    npm install
    ```

## 2. Start the app

1. Copy the local settings:

    ```bash
    cp .dev.vars.example .dev.vars
    ```

    They're for your computer only, and send email to the stand-in.

1. Start the app:

    ```bash
    npm run dev
    ```

    The first time, it creates the local database and asks you to confirm its migrations. Answer yes. The server keeps running in this terminal, and its output ends with the address it's ready on.

1. Open http://localhost:8787/dashboard/ to see the editor. There's nothing to sign in with on your computer. If another app already uses port 8787, Kestrel picks a free port instead, and the `Ready on` line shows it.

## 3. Load the demo publication

The demo fills the editor with posts, subscribers, and sends that already went out, so you can see the app in use.

1. In a second terminal, in the same folder, load the demo:

    ```bash
    npm run seed
    ```

    It replaces everything in the local database, and lists links to the editor and the demo's published posts.

1. To empty the local database again, and see the app as a new instance starts:

    ```bash
    npm run reset
    ```

1. To stop the server, press <kbd>Ctrl</kbd>+<kbd>C</kbd> in its terminal. Your local content stays for the next `npm run dev`.

## Check it

1. The app answers. If `npm run dev` picked another port, use the one on its `Ready on` line here and below:

    ```bash
    curl http://localhost:8787/health
    ```

    ```
    {"status":"ok","service":"kestrel"}
    ```

1. After `npm run seed`, http://localhost:8787/ shows the demo publication's public landing page, with its posts.

## Keep the folder for your instance

If you came here from Deploy the app, your folder is already a repository: go back to [Sign in to Cloudflare](../get-started/02-deploy.md#2-sign-in-to-cloudflare).

When you're ready to deploy, this folder can be your instance's repository. You need [Git](https://git-scm.com/) and a GitHub account for this part. The folder's `.gitignore` already keeps your local settings, the local database, and the installed packages out of it.

1. On GitHub, [create a new repository](https://github.com/new) named `newsletter`. It can be private. Leave it empty, with no README, license, or `.gitignore`.

1. Make the folder a repository, and commit the instance. Replace `YOUR_USERNAME` with your GitHub username:

    ```bash
    git init
    git add -A
    git commit -m "Start a Kestrel instance"
    git remote add origin https://github.com/YOUR_USERNAME/newsletter.git
    git push -u origin HEAD
    ```

Then check [what deploying needs](../get-started/02-deploy.md#before-you-begin) and [choose your hostnames](../get-started/02-deploy.md#choose-your-hostnames). Then [deploy the app](../get-started/02-deploy.md#2-sign-in-to-cloudflare) from signing in to Cloudflare onward.
