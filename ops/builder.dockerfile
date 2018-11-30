FROM node:10-alpine
WORKDIR /root

# Install native build tools
RUN apk add --update --no-cache bash curl g++ gcc git jq make python
RUN yarn global add ganache-cli truffle tsc

ENTRYPOINT ["bash", "-c"]
