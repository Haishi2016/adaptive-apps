FROM golang:1.26.8 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /platform-api .

FROM gcr.io/distroless/static:nonroot
COPY --from=build /platform-api /platform-api
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/platform-api"]
