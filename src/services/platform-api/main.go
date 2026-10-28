package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"k8s.io/client-go/dynamic"
	core "k8s.io/client-go/kubernetes/typed/core/v1"
	"k8s.io/client-go/rest"
)

func main() {
	namespace := os.Getenv("K8S_NAMESPACE")
	if namespace == "" {
		log.Fatal("K8S_NAMESPACE is required")
	}
	cfg, err := rest.InClusterConfig()
	if err != nil {
		log.Fatal("in-cluster Kubernetes configuration unavailable")
	}
	cfg.Timeout = 15 * time.Second
	objects, err := dynamic.NewForConfig(cfg)
	if err != nil {
		log.Fatal("Kubernetes resource client unavailable")
	}
	configs, err := core.NewForConfig(cfg)
	if err != nil {
		log.Fatal("Kubernetes ConfigMap client unavailable")
	}
	monitor, err := monitorFromEnvironment()
	if err != nil {
		log.Fatal(err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	api := &API{namespace: namespace, objects: objects, core: configs, monitor: monitor}
	server := &http.Server{
		Addr: "0.0.0.0:8080", Handler: api.handler(),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
		WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second,
		MaxHeaderBytes: 16 << 10,
		BaseContext:    func(net.Listener) context.Context { return ctx },
	}
	go func() {
		<-ctx.Done()
		shutdown, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		_ = server.Shutdown(shutdown)
	}()
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal("HTTP server failed")
	}
}
