## About this project
This website serves as a platform for LLM prompt injection data gathering. Users will intereact with a LLM agent that has specific instructions to follow and access to tools to complete workflows. The user's goal is to convince the agent to do harmful or unintended behaviour such as deleting a folder was instructed to not touch.

![Direct Prompt Injection](./webpreview.png)

## Architecture
1. An Ollama server hosts the LLM.
2. OpenCode instances are ran in Kubernetes pods which can communicate with the Ollama .server. 
3. Pods are spun up when a user enters the direct injection page and destroyed when exiting.
4. React is used for the frontend while a Node.js server is used for the backend.
5. (WIP) $<$ Database $>$ will be used for storage.

# Setup
- Create a .env with the example.env values replaced with your respective values.
## Ollama setup
1. Download Ollama: https://ollama.com/download/windows
2. Pull Qwen3:8b in a terminal: `ollama pull qwen3:8b`
3. Create pi-reseach-agent model in the opencode-ollama folder: `ollama create pi-reseach-agent -f ./Modelfile`
4. Serve the model: `OLLAMA_GO_TEMPLATE=false ollama serve`

## Kubernetes 
Please see [OpenCode-Kubernetes](opencode-ollama/README.md) setup.

## Front End (Local Development)
For running the frontend locally:
1. Have node.js installed https://nodejs.org/en/download
2. install dependencies: `nmp install`
3. Start Vite: `npx vite`

## Node.js Server
1. Have node.js installed https://nodejs.org/en/download
2. Install dependencies: `nmp install`
3. Run the server: `HOST=0.0.0.0 PORT=3001 npx tsx ./src/backend/server.ts`


## LightSail and Nginx Setup

## Deployment
Make sure to download SSH keys from the instance and rember their paths.
1. Build and copy to the LightSail instance
```
npm ci 
npx vite build

scp -i "C:\path\to\LightsailKey.pem" -r .\dist\* username@YOUR_STATIC_IP:/tmp/site/
```

2. SSH into the LightSail instance and run:
```
sudo mkdir -p /var/www/prompt-injection
sudo cp -r /tmp/site/. /var/www/prompt-injection/
sudo chown -R www-data:www-data /var/www/prompt-injection
```
