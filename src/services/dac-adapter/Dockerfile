FROM golang:1.26.8 AS build
WORKDIR /src
COPY go.mod *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /dac-adapter .

FROM gcr.io/distroless/static:nonroot
COPY --from=build /dac-adapter /dac-adapter
USER 65532:65532
ENTRYPOINT ["/dac-adapter"]
