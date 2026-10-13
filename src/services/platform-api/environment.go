package main

import (
	"encoding/json"
	"net/http"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type environmentDocument struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
	Cloud       *struct {
		Enabled                *bool   `json:"enabled"`
		FoundryProjectEndpoint *string `json:"foundryProjectEndpoint"`
		FoundryProjectARMID    *string `json:"foundryProjectArmId"`
	} `json:"cloud"`
}

func (a *API) environment(r *http.Request) (any, error) {
	cm, err := a.core.ConfigMaps(a.namespace).Get(r.Context(), "environment-config", metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	var document environmentDocument
	if json.Unmarshal([]byte(cm.Data["environment.json"]), &document) != nil ||
		document.Name == nil || document.Cloud == nil || document.Cloud.Enabled == nil || cm.DeletionTimestamp != nil {
		return nil, unavailable("environment-config is missing or invalid")
	}
	return document, nil
}
