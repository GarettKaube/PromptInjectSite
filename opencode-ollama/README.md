## OpenCode image

Build the image with `docker build -t opencode-ollama-pi-env:latest .` from this directory, then make it available to the Kubernetes nodes (for example, push it to a registry or load it into a local cluster).

The OpenCode config inside the image must point to an Ollama endpoint that is reachable from Kubernetes Pods. The current `host.docker.internal` URL may need to be changed.

The secretpswd.txt file is a fake password and is not sensitive information.

## Kubernetes setup

Create the password Secret in the namespace used by the website server:

```sh
kubectl create secret generic opencode-auth \
  --from-literal=OPENCODE_SERVER_PASSWORD='your-password' \
  -n your-namespace
```
Apply the OpenCode service:`opencodeservice.yaml`: `kubectl apply -n <namespace> -f opencodeservice.yaml` 

Apply `opencodedeployment.yaml` in that namespace. It is kept at zero replicas because the website creates one standalone OpenCode Pod per injection browser session. Command:
`kubectl apply -n <namespace> -f opencodedeployment.yaml`

For a website backend deployed inside Kubernetes, apply `injection-pod-rbac.yaml` in the same namespace, update the RoleBinding's ServiceAccount namespace if needed, and set `serviceAccountName: prompt-injection-server` on the website backend Deployment. For local development, grant the active kubeconfig identity permission to create, get, list, and delete Pods in that namespace; the backend starts and stops a `kubectl port-forward` for each session Pod.

The session Pods use the same image and password Secret. The website server also needs `OPENCODE_SERVER_PASSWORD` set so it can authenticate to each Pod.

