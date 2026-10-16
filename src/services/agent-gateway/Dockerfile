FROM golang:1.26.8 AS build
WORKDIR /src
COPY go.mod *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /agent-gateway .

FROM gcr.io/distroless/static:nonroot
COPY --from=build /agent-gateway /agent-gateway
USER 65532:65532
ENTRYPOINT ["/agent-gateway"]
