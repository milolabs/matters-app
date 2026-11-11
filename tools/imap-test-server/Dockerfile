# Throw-away IMAP server for integration tests: Debian's own dovecot-imapd, one user, plaintext
# auth, no TLS. Never expose this container to a network. Written for this repo; it does not
# use the dovecot/docker project (CC BY-NC-SA 4.0).
FROM debian:stable-slim

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends dovecot-imapd \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 5000 --home-dir /srv/mail --shell /usr/sbin/nologin vmail \
 && mkdir -p /srv/mail \
 && chown vmail:vmail /srv/mail

COPY dovecot.conf /etc/dovecot/dovecot.conf
# Test credentials for this local container only.
RUN echo 'test@example.test:{PLAIN}test-password' > /etc/dovecot/users

EXPOSE 143
ENTRYPOINT ["/usr/sbin/dovecot", "-F"]
