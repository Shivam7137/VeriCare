# Hosted demo (Cloud Run)

The public demo runs as one container on Google Cloud Run: PostgreSQL, the API, the worker and the web app together. Only the web app listens beyond loopback; the API, the OPOR feed listener and the database stay inside the container.

- **Live:** https://vericare-731923006486.us-central1.run.app (service `vericare`, project `staff-schedule-b951f`, region `us-central1`).
- **Fresh on every boot.** `deploy/huggingface/start.sh` creates an empty database, runs the migrations, seed, clinic population and fictional emergency contact, provisions demo sessions that last 30 days (`DEMO_SESSION_HOURS`, default 720 there), then starts everything. Nothing persists between instances, which suits a demo that resets itself anyway.
- **Free tier.** One instance at most (`--max-instances 1`, so every visitor shares one department), scaled to zero when idle (`--min-instances 0`), CPU always on while it runs (`--no-cpu-throttling`, so the worker and the demo clock keep moving between requests). A cold start takes about a minute.
- **Nothing live leaves it.** Texts and calls are simulated, the Visit Agent uses its rules planner and no provider keys are configured. To let a language model plan, add `OPENAI_API_KEY` as a secret and `VISIT_AGENT_ENABLED=true`; that spends tokens on every visitor's actions.
- **Anyone with the link can use every control, including Reset.** That is the point of the demo; it holds only fictional records.

## Redeploy

```sh
node scripts/hf-bundle.mjs
gcloud run deploy vericare --project staff-schedule-b951f --region us-central1 --source work/hf-space \
  --execution-environment gen2 --no-cpu-throttling --cpu-boost --cpu 1 --memory 2Gi \
  --min-instances 0 --max-instances 1 --concurrency 80 --timeout 300 \
  --set-env-vars PUBLIC_DEMO_ORIGIN=https://vericare-731923006486.us-central1.run.app \
  --allow-unauthenticated
```

`scripts/hf-bundle.mjs` copies the files Git would track into `work/hf-space`, leaving out `ml/`, `docs/`, `pitch/` and every `.env` file, and puts `deploy/huggingface/Dockerfile` at the root. The same folder also works as a Hugging Face Docker Space (which needs a paid plan). `PUBLIC_DEMO_ORIGIN` must be the exact HTTPS origin, or the automatic demo sign-in refuses the request.

To test the image locally: `docker build -t vericare-hf work/hf-space`, then `docker run -p 127.0.0.1:3105:7860 -e PUBLIC_DEMO_ORIGIN=https://127.0.0.1:3105 vericare-hf` and send requests with `X-Forwarded-Proto: https`.

To take it down: `gcloud run services delete vericare --project staff-schedule-b951f --region us-central1`.
