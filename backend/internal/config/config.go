package config

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

var placeholders = map[string]bool{
	"":          true,
	"admin":     true,
	"change-me": true,
	"changeme":  true,
	"password":  true,
	"secret":    true,
}

type Config struct {
	AppPassword          string
	JWTSecret            string
	DatabaseURL          string
	StoragePath          string
	AccessTokenMinutes   int
	RefreshTokenDays     int
	MaxFileSize          int64
	UploadURLTTLSeconds  int
	CORSOrigins          string
	TrustedProxies       string
	Port                 string
	TrustedProxyNetworks []*net.IPNet
	TrustedProxyIPs      []net.IP
}

// Load loads configuration from environment variables and an optional .env file.
func Load() (*Config, error) {
	loadDotEnv()

	cfg := &Config{
		AppPassword:         getEnv("APP_PASSWORD", ""),
		JWTSecret:           getEnv("JWT_SECRET", ""),
		DatabaseURL:         getEnv("DATABASE_URL", "postgresql+asyncpg://privatedrop:privatedrop@localhost:5432/privatedrop"),
		StoragePath:         getEnv("STORAGE_PATH", "./data/storage"),
		AccessTokenMinutes:  getEnvInt("ACCESS_TOKEN_MINUTES", 15),
		RefreshTokenDays:    getEnvInt("REFRESH_TOKEN_DAYS", 30),
		MaxFileSize:         getEnvInt64("MAX_FILE_SIZE", 5368709120),
		UploadURLTTLSeconds: getEnvInt("UPLOAD_URL_TTL_SECONDS", 900),
		CORSOrigins:         getEnv("CORS_ORIGINS", ""),
		TrustedProxies:      getEnv("TRUSTED_PROXIES", "127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"),
		Port:                getEnv("PORT", "8000"),
	}

	// Clean and normalize database URL
	cfg.DatabaseURL = NormalizeDatabaseURL(cfg.DatabaseURL)

	cfg.ParseTrustedProxies()

	return cfg, nil
}

// ParseTrustedProxies parses the TrustedProxies field into networks/IPs.
// Split from Load so tests assembling a Config manually get identical behavior.
func (c *Config) ParseTrustedProxies() {
	for _, raw := range c.TrustedProxyList() {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		if strings.Contains(raw, "/") {
			_, ipNet, err := net.ParseCIDR(raw)
			if err == nil {
				c.TrustedProxyNetworks = append(c.TrustedProxyNetworks, ipNet)
			}
		} else {
			ip := net.ParseIP(raw)
			if ip != nil {
				c.TrustedProxyIPs = append(c.TrustedProxyIPs, ip)
			}
		}
	}
}

func (c *Config) ValidateSecrets() error {
	var problems []string

	pwd := strings.TrimSpace(c.AppPassword)
	if placeholders[strings.ToLower(pwd)] {
		problems = append(problems, "APP_PASSWORD must be set to a non-placeholder value")
	} else if len(pwd) < 6 {
		problems = append(problems, "APP_PASSWORD must be at least 6 characters long")
	}

	secret := strings.TrimSpace(c.JWTSecret)
	if placeholders[strings.ToLower(secret)] {
		problems = append(problems, "JWT_SECRET must be set to a non-placeholder value")
	} else if len(secret) < 16 {
		problems = append(problems, "JWT_SECRET must be at least 16 characters long")
	}

	if len(problems) > 0 {
		return fmt.Errorf("invalid startup configuration:\n  - %s", strings.Join(problems, "\n  - "))
	}
	return nil
}

func (c *Config) CORSOriginList() []string {
	var list []string
	for _, o := range strings.Split(c.CORSOrigins, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			list = append(list, o)
		}
	}
	return list
}

func (c *Config) TrustedProxyList() []string {
	var list []string
	for _, p := range strings.Split(c.TrustedProxies, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			list = append(list, p)
		}
	}
	return list
}

func (c *Config) IsTrustedProxy(ipStr string) bool {
	ip := net.ParseIP(strings.TrimSpace(ipStr))
	if ip == nil {
		return false
	}
	for _, netw := range c.TrustedProxyNetworks {
		if netw.Contains(ip) {
			return true
		}
	}
	for _, trustedIP := range c.TrustedProxyIPs {
		if trustedIP.Equal(ip) {
			return true
		}
	}
	return false
}

// NormalizeDatabaseURL handles postgresql+asyncpg:// or similar schemes.
func NormalizeDatabaseURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "postgresql+asyncpg://") {
		return "postgres://" + strings.TrimPrefix(raw, "postgresql+asyncpg://")
	}
	if strings.HasPrefix(raw, "postgresql://") {
		return "postgres://" + strings.TrimPrefix(raw, "postgresql://")
	}
	return raw
}

func getEnv(key, defaultVal string) string {
	if val, ok := os.LookupEnv(key); ok {
		return val
	}
	return defaultVal
}

func getEnvInt(key string, defaultVal int) int {
	if val, ok := os.LookupEnv(key); ok {
		if i, err := strconv.Atoi(val); err == nil {
			return i
		}
	}
	return defaultVal
}

func getEnvInt64(key string, defaultVal int64) int64 {
	if val, ok := os.LookupEnv(key); ok {
		if i, err := strconv.ParseInt(val, 10, 64); err == nil {
			return i
		}
	}
	return defaultVal
}

// loadDotEnv scans for .env file starting from working directory upwards.
func loadDotEnv() {
	dir, err := os.Getwd()
	if err != nil {
		return
	}
	for {
		envPath := filepath.Join(dir, ".env")
		if fi, err := os.Stat(envPath); err == nil && !fi.IsDir() {
			parseEnvFile(envPath)
			return
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
}

func parseEnvFile(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 {
			key := strings.TrimSpace(parts[0])
			val := strings.TrimSpace(parts[1])
			// Strip quotes if any
			if len(val) >= 2 && ((val[0] == '"' && val[len(val)-1] == '"') || (val[0] == '\'' && val[len(val)-1] == '\'')) {
				val = val[1 : len(val)-1]
			}
			// Only set if not already set in OS environment
			if _, exists := os.LookupEnv(key); !exists {
				_ = os.Setenv(key, val)
			}
		}
	}
}

