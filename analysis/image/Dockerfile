FROM python@sha256:0f086103b026048cc50cb5da25ec435c023c5241a83fc44daea593377abc61c4 AS assemble
COPY wheels.lock /lock
RUN mkdir -p /runtime/usr/local/bin /runtime/usr/local/lib /runtime/lib64 /runtime/lib/x86_64-linux-gnu /runtime/tmp \
 && cp -L /usr/local/bin/python3.12 /runtime/usr/local/bin/python \
 && cp -L /lib64/ld-linux-x86-64.so.2 /runtime/lib64/ \
 && cp -a /usr/local/lib/libpython3.12.so* /usr/local/lib/python3.12 /runtime/usr/local/lib/ \
 && rm -rf /runtime/usr/local/lib/python3.12/ensurepip /runtime/usr/local/lib/python3.12/site-packages \
 && cp -a /usr/lib/x86_64-linux-gnu/. /runtime/lib/x86_64-linux-gnu/ \
 && cp /etc/ld.so.cache /runtime/ld.so.cache.tmp \
 && mkdir -p /runtime/etc /runtime/usr/share \
 && mv /runtime/ld.so.cache.tmp /runtime/etc/ld.so.cache \
 && cp -a /usr/share/zoneinfo /runtime/usr/share/ \
 && pip --disable-pip-version-check install --no-cache-dir --no-compile --require-hashes --only-binary=:all: --target=/runtime/usr/local/lib/python3.12/site-packages -r /lock \
 && rm -rf /runtime/usr/local/lib/python3.12/site-packages/bin \
 && chmod 1777 /runtime/tmp
FROM scratch
COPY --from=assemble /runtime/ /
ENV PATH=/usr/local/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC HOME=/tmp PYTHONDONTWRITEBYTECODE=1 PYTHONHASHSEED=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1 MPLBACKEND=Agg MPLCONFIGDIR=/tmp/matplotlib
USER 65534:65534
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/python"]
