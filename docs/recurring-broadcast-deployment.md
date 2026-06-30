# Deploying Recurring WhatsApp Broadcasts with External Cron Services

Because the Vercel Hobby plan does not support cron jobs that run more frequently than twice daily (e.g. every minute), you must use an external HTTP cron provider to trigger the execution scheduler.

The scheduler endpoint is fully hosting-provider independent and can be triggered by any external HTTP scheduling service.

---

## Endpoint Configuration Specifications

When configuring your external cron provider, use these exact parameters:

* **URL to Request:** `https://<your-vercel-domain>.vercel.app/api/automations/cron`
* **HTTP Method:** `GET`
* **Required Headers:**
  * `x-cron-secret`: `<AUTOMATION_CRON_SECRET>`
* **Execution Interval:** `Every 1 minute` (Recommended) or `Every 5 minutes`

> [!IMPORTANT]
> Ensure the value of `<AUTOMATION_CRON_SECRET>` matches the `AUTOMATION_CRON_SECRET` environment variable configured in your Vercel deployment exactly. If they do not match, the server will return `401 Unauthorized`.

---

## step-by-step Provider Setup

### 1. cron-job.org (Free)
1. Register or log in to [cron-job.org](https://cron-job.org).
2. Go to the **Cronjobs** dashboard and click **Create Cronjob**.
3. **Title:** `WACRM Broadcast Scheduler`
4. **Address (URL):** `https://<your-vercel-domain>.vercel.app/api/automations/cron`
5. **Request Method:** Select `GET`.
6. **Headers:**
   * Under HTTP headers, click **Add header**.
   * Set Key to `x-cron-secret` and Value to your `<AUTOMATION_CRON_SECRET>`.
7. **Schedule:**
   * Under Execution schedule, select **User-defined**.
   * Set it to run **Every 1 minute** (or select intervals under "Minutes" → check all boxes).
8. Click **Create**.

---

### 2. Better Stack Crons (Uptime)
1. Log in to [Better Stack](https://betterstack.com).
2. Navigate to **Uptime** → **Monitors** and click **Create monitor**.
3. **URL to monitor:** `https://<your-vercel-domain>.vercel.app/api/automations/cron`
4. **Alert us if the URL:** fails to return HTTP status `200`.
5. **HTTP Headers:**
   * Click **Add HTTP header**.
   * Name: `x-cron-secret`
   * Value: `<AUTOMATION_CRON_SECRET>`
6. **Check frequency:** Select `1 min`.
7. Click **Create monitor**.

---

### 3. EasyCron (Premium / Hobby)
1. Log in to [EasyCron](https://www.easycron.com).
2. Click **Create Cron Job** on your dashboard.
3. **URL to call:** `https://<your-vercel-domain>.vercel.app/api/automations/cron`
4. **Interval:** Set `Every 1 minute`.
5. **HTTP Headers:**
   * Scroll down to the headers configuration section.
   * Add header: `x-cron-secret: <AUTOMATION_CRON_SECRET>`.
6. Click **Create Cron Job**.
