FROM golang:1.26.6-alpine AS build
WORKDIR /src
COPY agents/probe/go.mod ./
COPY agents/probe/ ./
COPY packages/contracts/examples/week3-three-region.json /contracts/week3-three-region.json
RUN ARGUS_CONTRACT_FIXTURE=/contracts/week3-three-region.json go test ./...
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/argus-probe ./cmd/argus-probe

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/argus-probe /argus-probe
USER nonroot:nonroot
ENTRYPOINT ["/argus-probe"]
CMD ["self-test"]
